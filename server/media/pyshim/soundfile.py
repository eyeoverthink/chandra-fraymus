"""Stand-in for the `soundfile` package: WAV read and write only, on the standard library.

fraymus-video-studio imports `soundfile` to write its mix and to read audio returned by an HTTP
voice endpoint. Both are plain PCM WAV in the way Chandra drives it, so this module covers them with
`wave` + NumPy and nothing has to be downloaded. Chandra puts this directory on PYTHONPATH only when
the real package is not installed; install `soundfile` and this file is never imported.

Not supported (the real package is needed): FLAC/OGG/MP3, float or extensible WAV, seeking, metadata.
"""
import wave
import numpy as np

__version__ = "0.0-chandra-shim"
_SHIM = True


def _open(file, mode):
    return wave.open(file if hasattr(file, "read") or hasattr(file, "write") else str(file), mode)


def write(file, data, samplerate, subtype=None, format=None, **_):
    if subtype not in (None, "PCM_16"):
        raise ValueError(f"soundfile shim writes PCM_16 only, not {subtype}")
    a = np.asarray(data, dtype=np.float32)
    channels = 1 if a.ndim == 1 else a.shape[1]
    pcm = np.round(np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2")
    with _open(file, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(int(samplerate))
        w.writeframes(pcm.tobytes())


def read(file, dtype="float64", always_2d=False, **_):
    with _open(file, "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    if width == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif width == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        a = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float64) / float(1 << 23)
    elif width == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float64) / float(1 << 31)
    else:
        raise ValueError(f"soundfile shim cannot read {width * 8}-bit WAV")
    if channels > 1 or always_2d:
        a = a.reshape(-1, channels)
    return a.astype(dtype), rate
