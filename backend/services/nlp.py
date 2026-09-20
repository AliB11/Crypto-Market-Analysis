"""Transformer-based financial sentiment inference engine.

Wraps a HuggingFace ``transformers`` text-classification pipeline and exposes
a small, dependency-injectable interface so that:

* production uses ``cardiffnlp/twitter-roberta-base-sentiment-latest``
  (3-class Twitter RoBERTa) with automatic fallback to ``ProsusAI/finbert``,
* unit tests inject a deterministic fake pipeline without downloading
  multi-hundred-megabyte weights.

The heavy imports (``torch`` / ``transformers``) are performed lazily inside
:meth:`SentimentInferenceEngine.load` so that importing this module never
pulls the ML stack into processes that do not need it (e.g. the API gateway
and the pytest suite).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Sequence, Tuple

from config import Settings, get_settings

logger = logging.getLogger(__name__)

# Label → polarity mapping shared by the supported models.
_TWITTER_ROBERTA_LABELS = {
    "negative": -1.0,
    "neutral": 0.0,
    "positive": 1.0,
    # cardiffnlp models sometimes expose raw LABEL_n keys (standard order).
    "label_0": -1.0,
    "label_1": 0.0,
    "label_2": 1.0,
}
_FINBERT_LABELS = {"negative": -1.0, "neutral": 0.0, "positive": 1.0}


@dataclass(frozen=True)
class SentimentPrediction:
    """Single-record inference result."""

    polarity: float  # in [-1, 1]
    confidence: float  # softmax probability of the argmax label, [0, 1]
    label: str
    inference_ms: float


class SentimentInferenceEngine:
    """Batch contextual sentiment scoring with a pretrained transformer.

    Parameters
    ----------
    model_id:
        HuggingFace model identifier.  ``None`` uses the configured default.
    device:
        ``"cpu"``, ``"cuda"`` or ``"mps"``; defaults to the configured value.
    batch_size:
        Maximum texts per forward pass.
    pipeline_factory:
        Optional callable ``(model_id, device) -> pipeline``.  Injected by
        tests; production default lazily builds a real transformers pipeline.

    Notes
    -----
    Mappings applied to model output:

    ``polarity = label_polarity[argmax(softmax)]`` where ``label_polarity``
    maps ``negative/neutral/positive`` onto ``-1/0/+1``.  ``confidence`` is
    the argmax softmax probability.  Texts longer than the model's context
    window are truncated by the tokenizer (``truncation=True``).
    """

    def __init__(
        self,
        model_id: Optional[str] = None,
        device: Optional[str] = None,
        batch_size: Optional[int] = None,
        pipeline_factory: Optional[Callable[[str, str], Any]] = None,
        settings: Optional[Settings] = None,
    ) -> None:
        self._settings = settings or get_settings()
        self.model_id = model_id or self._settings.SENTIMENT_MODEL_ID
        self.device = device or self._settings.NLP_DEVICE
        self.batch_size = batch_size or self._settings.NLP_BATCH_SIZE
        self._pipeline_factory = pipeline_factory
        self._pipeline: Any = None
        self._label_map = _TWITTER_ROBERTA_LABELS

    # ------------------------------------------------------------- lifecycle
    def load(self) -> "SentimentInferenceEngine":
        """Materialise the underlying transformer pipeline (idempotent)."""
        if self._pipeline is not None:
            return self
        started = time.perf_counter()
        if self._pipeline_factory is not None:
            logger.info("Loading sentiment pipeline via injected factory: %s", self.model_id)
            self._pipeline = self._pipeline_factory(self.model_id, self.device)
        else:
            try:
                self._pipeline = self._build_default_pipeline(self.model_id)
            except Exception as primary_error:  # pragma: no cover - model download failure
                fallback = self._settings.SENTIMENT_MODEL_FALLBACK_ID
                logger.warning(
                    "Primary sentiment model %s failed (%s); falling back to %s",
                    self.model_id,
                    primary_error,
                    fallback,
                )
                self._pipeline = self._build_default_pipeline(fallback)
                self.model_id = fallback
                self._label_map = _FINBERT_LABELS
        logger.info(
            "Sentiment pipeline ready (%s, device=%s) in %.1fs",
            self.model_id,
            self.device,
            time.perf_counter() - started,
        )
        return self

    def _build_default_pipeline(self, model_id: str) -> Any:
        # Lazy import keeps torch/transformers out of non-ML processes.
        from transformers import (  # type: ignore[import-untyped]
            TextClassificationPipeline,
            AutoModelForSequenceClassification,
            AutoTokenizer,
        )

        tokenizer = AutoTokenizer.from_pretrained(model_id, truncation=True, max_length=256)
        model = AutoModelForSequenceClassification.from_pretrained(model_id)
        try:
            import torch  # type: ignore[import-untyped]

            if self.device == "cuda" and torch.cuda.is_available():
                model = model.to("cuda")
            elif self.device == "mps":
                model = model.to("mps")
        except ImportError:  # pragma: no cover - torch always present in worker image
            pass
        return TextClassificationPipeline(
            tokenizer=tokenizer,
            model=model,
            return_all_scores=False,
            truncation=True,
        )

    @property
    def is_loaded(self) -> bool:
        return self._pipeline is not None

    # -------------------------------------------------------------- inference
    def score(self, texts: Sequence[str]) -> List[SentimentPrediction]:
        """Score a batch of texts, preserving input order.

        Empty inputs return ``[]``; blank strings yield neutral predictions
        with zero confidence so downstream weighting naturally discards them.
        """
        if not texts:
            return []
        if self._pipeline is None:
            self.load()
        results: List[SentimentPrediction] = []
        for start in range(0, len(texts), self.batch_size):
            chunk = [t if t else " " for t in texts[start : start + self.batch_size]]
            started = time.perf_counter()
            raw = list(self._pipeline(chunk))
            elapsed = (time.perf_counter() - started) * 1000.0 / max(1, len(chunk))
            results.extend(self._parse_outputs(raw, elapsed))
        return results

    def score_one(self, text: str) -> SentimentPrediction:
        return self.score([text])[0]

    # ---------------------------------------------------------------- helpers
    def _parse_outputs(self, raw_outputs: Sequence[Any], per_item_ms: float) -> List[SentimentPrediction]:
        parsed: List[SentimentPrediction] = []
        for output in raw_outputs:
            label_raw, score = self._extract_label_and_score(output)
            label = str(label_raw).lower()
            if label not in self._label_map:
                # Robust to models exposing e.g. "LABEL_0" or "pos"/"neg".
                if "neg" in label:
                    label = "negative"
                elif "pos" in label:
                    label = "positive"
                else:
                    label = "neutral"
            parsed.append(
                SentimentPrediction(
                    polarity=self._label_map[label],
                    confidence=float(min(1.0, max(0.0, score))),
                    label=label,
                    inference_ms=per_item_ms,
                )
            )
        return parsed

    @staticmethod
    def _extract_label_and_score(output: Any) -> Tuple[str, float]:
        """Normalise the many historical shapes of pipeline outputs."""
        if isinstance(output, dict):
            return output.get("label", "neutral"), output.get("score", 0.0)
        if isinstance(output, (list, tuple)) and output:
            return SentimentInferenceEngine._extract_label_and_score(output[0])
        return "neutral", 0.0
