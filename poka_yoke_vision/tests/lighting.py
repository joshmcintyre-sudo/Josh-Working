"""Simulated shop-floor lighting conditions for stress-testing detection."""
import cv2
import numpy as np


def _gain(img, g):
    return np.clip(img.astype(np.float32) * g, 0, 255).astype(np.uint8)


def _field(img, fn):
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return _gain(img, fn(xx / w, yy / h)[..., None])


def _noise(img, sigma, seed=1):
    n = np.random.default_rng(seed).normal(0, sigma, img.shape)
    return np.clip(img.astype(np.float32) + n, 0, 255).astype(np.uint8)


def _wb(img, b, g, r):
    return np.clip(img.astype(np.float32) * np.array([b, g, r], np.float32), 0, 255).astype(np.uint8)


def _shadow(img, cx, cy, rx, ry, depth=0.5):
    m = np.zeros(img.shape[:2], np.float32)
    cv2.ellipse(m, (cx, cy), (rx, ry), 20, 0, 360, 1.0, -1)
    m = cv2.GaussianBlur(m, (0, 0), 25)
    return _gain(img, (1 - depth * m)[..., None])


def _gamma(img, g):
    lut = np.array([((i / 255) ** g) * 255 for i in range(256)], np.uint8)
    return cv2.LUT(img, lut)


CONDITIONS = {
    "normal": lambda im: im,
    "dim_50": lambda im: _gain(im, 0.5),
    "dark_30_noisy": lambda im: _noise(_gain(im, 0.3), 4),
    "bright_clipped": lambda im: _gain(im, 1.6),
    "gradient_lr": lambda im: _field(im, lambda x, y: 0.45 + 0.85 * x),
    "gradient_tb": lambda im: _field(im, lambda x, y: 1.25 - 0.75 * y),
    "spotlight": lambda im: _field(im, lambda x, y: 1.25 - 0.9 * ((x - 0.4) ** 2 + (y - 0.4) ** 2)),
    "warm_wb": lambda im: _wb(im, 0.72, 0.95, 1.18),
    "cool_wb": lambda im: _wb(im, 1.2, 1.0, 0.8),
    "soft_shadow": lambda im: _shadow(im, 560, 300, 330, 150, 0.5),
    "exposure_curve": lambda im: _gamma(im, 1.5),
    "noisy": lambda im: _noise(im, 9),
}
