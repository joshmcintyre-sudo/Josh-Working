"""Detection clean-up shared by the fixed and fisheye detectors."""
import numpy as np


def container_mask(xyxy: np.ndarray, contain: float = 0.8, area_ratio: float = 1.6) -> np.ndarray:
    """True for boxes to KEEP. Drops 'group boxes' that wrap another person box (two people
    standing together detected as one big box as well as individually) - plain NMS misses these
    because the IoU of a big box and a small box inside it is low."""
    n = len(xyxy)
    keep = np.ones(n, bool)
    if n < 2:
        return keep
    area = (xyxy[:, 2] - xyxy[:, 0]) * (xyxy[:, 3] - xyxy[:, 1])
    for i in range(n):
        for j in range(n):
            if i == j or area[i] < area_ratio * area[j]:
                continue
            iw = min(xyxy[i, 2], xyxy[j, 2]) - max(xyxy[i, 0], xyxy[j, 0])
            ih = min(xyxy[i, 3], xyxy[j, 3]) - max(xyxy[i, 1], xyxy[j, 1])
            if iw > 0 and ih > 0 and iw * ih >= contain * area[j]:
                keep[i] = False  # i wraps person j
                break
    return keep
