"""Play PCM into a dedicated VB-CABLE endpoint using the Windows audio API."""
import contextlib
import ctypes
from ctypes import wintypes
import time

SAMPLE_RATE = 16000
BYTE_RATE = SAMPLE_RATE * 2
MAX_PCM_BYTES = BYTE_RATE * 59
CABLE_MODEL = "VB-Audio Virtual Cable"
DEFAULT_CAPTURE_QUERIES = (0x2000 + 21, 0x2000 + 23)  # Default and default communications device.


class VoiceOutputError(Exception):
    pass


class WaveCaps(ctypes.Structure):
    _fields_ = [
        ("manufacturer", wintypes.WORD), ("product", wintypes.WORD), ("driver_version", wintypes.UINT),
        ("name", wintypes.WCHAR * 32), ("formats", wintypes.DWORD), ("channels", wintypes.WORD),
        ("reserved", wintypes.WORD),
    ]


class WaveOutCaps(WaveCaps):
    _fields_ = [("support", wintypes.DWORD)]


class WaveFormat(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("format", wintypes.WORD), ("channels", wintypes.WORD), ("rate", wintypes.DWORD),
        ("byte_rate", wintypes.DWORD), ("block_align", wintypes.WORD), ("bits", wintypes.WORD),
        ("extra_size", wintypes.WORD),
    ]


class WaveHeader(ctypes.Structure):
    _fields_ = [
        ("data", ctypes.c_void_p), ("length", wintypes.DWORD), ("bytes_recorded", wintypes.DWORD),
        ("user", ctypes.c_size_t), ("flags", wintypes.DWORD), ("loops", wintypes.DWORD),
        ("next", ctypes.c_void_p), ("reserved", ctypes.c_size_t),
    ]


def cable_device(count, get_caps, caps_type, endpoint):
    # The Windows MME name field contains at most 31 characters.
    expected = f"{endpoint} ({CABLE_MODEL})"[:31]
    matches = []
    for index in range(count()):
        caps = caps_type()
        if get_caps(index, ctypes.byref(caps), ctypes.sizeof(caps)) == 0 and caps.name == expected:
            matches.append(index)
    if len(matches) != 1:
        raise VoiceOutputError("VOICE_CABLE_NOT_READY")
    return matches[0]


class VoiceCable:
    def __init__(self):
        self.audio = ctypes.WinDLL("winmm")
        self.audio.waveInMessage.argtypes = (
            ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
        )
        self.audio.waveOutOpen.argtypes = (
            ctypes.POINTER(ctypes.c_void_p), wintypes.UINT, ctypes.POINTER(WaveFormat),
            ctypes.c_size_t, ctypes.c_size_t, wintypes.DWORD,
        )

    def device(self):
        output = cable_device(self.audio.waveOutGetNumDevs, self.audio.waveOutGetDevCapsW, WaveOutCaps, "CABLE Input")
        capture = cable_device(self.audio.waveInGetNumDevs, self.audio.waveInGetDevCapsW, WaveCaps, "CABLE Output")
        for query in DEFAULT_CAPTURE_QUERIES:
            device, flags = wintypes.DWORD(), wintypes.DWORD()
            if self.audio.waveInMessage(ctypes.c_void_p(0xFFFFFFFF), query, ctypes.byref(device), ctypes.byref(flags)) or device.value != capture:
                raise VoiceOutputError("VOICE_CABLE_NOT_DEFAULT_CAPTURE")
        return output

    @contextlib.contextmanager
    def prepare(self, pcm):
        device = self.device()
        handle = ctypes.c_void_p()
        fmt = WaveFormat(1, 1, SAMPLE_RATE, BYTE_RATE, 2, 16, 0)
        if self.audio.waveOutOpen(ctypes.byref(handle), device, ctypes.byref(fmt), 0, 0, 0):
            raise VoiceOutputError("VOICE_CABLE_PLAYBACK_FAILED")
        samples = ctypes.create_string_buffer(pcm)
        header = WaveHeader(ctypes.addressof(samples), len(pcm))
        size = ctypes.sizeof(header)
        try:
            if self.audio.waveOutPrepareHeader(handle, ctypes.byref(header), size):
                raise VoiceOutputError("VOICE_CABLE_PLAYBACK_FAILED")
            try:
                def play(guard):
                    if self.audio.waveOutWrite(handle, ctypes.byref(header), size):
                        raise VoiceOutputError("VOICE_CABLE_PLAYBACK_FAILED")
                    deadline = time.monotonic() + len(pcm) / BYTE_RATE + 2
                    while not header.flags & 1:  # WHDR_DONE
                        guard()
                        if time.monotonic() >= deadline:
                            raise VoiceOutputError("VOICE_CABLE_PLAYBACK_TIMEOUT")
                        time.sleep(0.05)
                yield play
            finally:
                if header.flags & 16:  # WHDR_INQUEUE
                    self.audio.waveOutReset(handle)
                self.audio.waveOutUnprepareHeader(handle, ctypes.byref(header), size)
        finally:
            self.audio.waveOutClose(handle)
