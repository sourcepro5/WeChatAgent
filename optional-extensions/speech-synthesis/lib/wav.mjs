const targetRate = 16000;
const maxSeconds = 60;
export const maximumWavBytes = 12 * 1024 * 1024;
const formatError = () => new Error('VOICE_TTS_INVALID_AUDIO');
const pcmFormatGuid = '0100000000001000800000aa00389b71';

function waveChunks(wav) {
  if (wav.length < 44 || wav.length > maximumWavBytes || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE') throw formatError();
  const riffSize = wav.readUInt32LE(4);
  const streaming = riffSize === 0xffffffff || riffSize === 0x7fffffff;
  if (!streaming && riffSize !== wav.length - 8) throw formatError();
  let format, data, offset = 12;
  while (offset + 8 <= wav.length) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (kind === 'data' && streaming && (size === 0xffffffff || size === 0x7fffffff)) {
      if (data) throw formatError();
      data = wav.subarray(start);
      offset = wav.length;
      break;
    }
    const end = start + size;
    offset = end + size % 2;
    if (offset > wav.length) throw formatError();
    if (kind === 'fmt ') {
      if (format || size < 16) throw formatError();
      format = wav.subarray(start, end);
    } else if (kind === 'data') {
      if (data) throw formatError();
      data = wav.subarray(start, end);
    }
  }
  if (offset !== wav.length || !format || !data?.length) throw formatError();
  return {format, data};
}

export function waveFile(pcm, outputRate = targetRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(outputRate, 24); header.writeUInt32LE(outputRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function normalizeWav(wav, outputRate = targetRate) {
  const {format, data} = waveChunks(wav);
  const tag = format.readUInt16LE(0);
  const pcm = tag === 1 || (tag === 0xfffe && format.length >= 40 && format.readUInt16LE(16) >= 22 &&
    format.readUInt16LE(18) === 16 && format.toString('hex', 24, 40) === pcmFormatGuid);
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4), stride = channels * 2;
  if (!pcm || ![1, 2].includes(channels) || rate < 8000 || rate > 48000 ||
      format.readUInt32LE(8) !== rate * stride || format.readUInt16LE(12) !== stride ||
      format.readUInt16LE(14) !== 16 || data.length % stride) throw formatError();
  const frames = data.length / stride;
  if (frames > rate * maxSeconds) throw new Error('VOICE_TTS_TOO_LONG');
  if (rate === outputRate && channels === 1) return {pcm: data, durationMs: Math.ceil(frames * 1000 / outputRate)};

  const ratio = rate / outputRate;
  const output = Buffer.alloc(Math.floor(frames / ratio) * 2);
  if (!output.length) throw formatError();
  const sample = index => {
    const offset = index * stride;
    const left = data.readInt16LE(offset);
    return channels === 1 ? left : (left + data.readInt16LE(offset + 2)) / 2;
  };
  for (let i = 0; i < output.length / 2; i++) {
    const start = i * ratio, first = Math.floor(start);
    let value;
    if (ratio < 1) {
      const blend = start - first;
      value = (1 - blend) * sample(first) + blend * sample(Math.min(first + 1, frames - 1));
    } else {
      const end = Math.min(frames, (i + 1) * ratio);
      let sum = 0;
      for (let index = first; index < Math.ceil(end); index++) {
        sum += sample(index) * (Math.min(index + 1, end) - Math.max(index, start));
      }
      value = sum / (end - start);
    }
    output.writeInt16LE(Math.round(value), i * 2);
  }
  return {pcm: output, durationMs: Math.ceil(output.length * 500 / outputRate)};
}
