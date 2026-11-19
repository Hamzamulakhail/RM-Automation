const VIDEO_EXTENSIONS = new Set(['mp4', 'mov']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB

export function parseMediaFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const ext = filename.slice(dotIdx + 1).toLowerCase();
  let mediaType = null;
  if (VIDEO_EXTENSIONS.has(ext)) mediaType = 'video';
  else if (IMAGE_EXTENSIONS.has(ext)) mediaType = 'image';
  else return null;

  const numMatch = /^\s*(\d{1,4})[\s._-]/.exec(filename);
  if (!numMatch) {
    return { number: null, ext, mediaType, name: filename };
  }
  return {
    number: Number(numMatch[1]),
    ext,
    mediaType,
    name: filename,
  };
}

export function parseCaptionsTxt(rawText) {
  const clean = (rawText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n');
  const blocks = [];
  const seenNumbers = new Set();
  const duplicates = [];

  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = /^\s*(\d+)\s*$/.exec(line);
    if (headerMatch) {
      if (current) {
        current.endLine = i;
        current.text = lines.slice(current.startLine + 1, i).join('\n').trim();
        blocks.push(current);
      }
      const num = Number(headerMatch[1]);
      if (seenNumbers.has(num)) {
        duplicates.push(num);
      } else {
        seenNumbers.add(num);
      }
      current = {
        number: num,
        rawHeader: line.trim(),
        startLine: i,
        endLine: lines.length,
        text: '',
      };
    }
  }

  if (current) {
    current.endLine = lines.length;
    current.text = lines.slice(current.startLine + 1, lines.length).join('\n').trim();
    blocks.push(current);
  }

  return { blocks, duplicates, lines };
}

export function removeCaptionBlock(rawText, captionNumber) {
  const { blocks, lines } = parseCaptionsTxt(rawText);
  const target = blocks.find((b) => b.number === Number(captionNumber));
  if (!target) {
    return { updatedText: rawText, removed: false };
  }

  const remaining = [
    ...lines.slice(0, target.startLine),
    ...lines.slice(target.endLine),
  ];

  // Trim leading/trailing blank lines cleanly while preserving internal block spacing
  while (remaining.length > 0 && remaining[0].trim() === '') {
    remaining.shift();
  }
  while (remaining.length > 0 && remaining[remaining.length - 1].trim() === '') {
    remaining.pop();
  }

  const updatedText = remaining.length > 0 ? `${remaining.join('\n')}\n` : '';
  return { updatedText, removed: true };
}

export function selectNextPair({ mediaFiles, captionsText, blockedFileIds = new Set() }) {
  const { blocks, duplicates } = parseCaptionsTxt(captionsText);

  const captionMap = new Map();
  for (const b of blocks) {
    if (!captionMap.has(b.number)) {
      captionMap.set(b.number, b);
    }
  }

  const validMediaByNum = new Map();
  const invalidMediaFiles = [];
  const blockedSkipped = [];

  for (const f of mediaFiles) {
    if (blockedFileIds.has(f.id)) {
      blockedSkipped.push({ id: f.id, name: f.name });
      continue;
    }
    const parsed = parseMediaFilename(f.name);
    if (!parsed) {
      invalidMediaFiles.push({ id: f.id, name: f.name, reason: 'unsupported_extension' });
      continue;
    }
    if (parsed.number === null) {
      invalidMediaFiles.push({ id: f.id, name: f.name, reason: 'missing_leading_number' });
      continue;
    }
    const entry = {
      ...f,
      number: parsed.number,
      ext: parsed.ext,
      mediaType: parsed.mediaType,
      sizeBytes: Number(f.size || 0),
    };
    if (!validMediaByNum.has(parsed.number)) {
      validMediaByNum.set(parsed.number, []);
    }
    validMediaByNum.get(parsed.number).push(entry);
  }

  // Sort media candidates inside each number by name for determinism
  for (const list of validMediaByNum.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  const mediaNums = Array.from(validMediaByNum.keys()).sort((a, b) => a - b);
  const captionNums = Array.from(captionMap.keys()).sort((a, b) => a - b);

  let selectedPair = null;
  const orphanFiles = [];
  const orphanCaptions = [];

  for (const num of mediaNums) {
    const filesForNum = validMediaByNum.get(num);
    if (captionMap.has(num)) {
      if (!selectedPair) {
        selectedPair = {
          number: num,
          file: filesForNum[0],
          caption: captionMap.get(num),
        };
      }
      if (filesForNum.length > 1) {
        for (let i = 1; i < filesForNum.length; i++) {
          orphanFiles.push({ number: num, id: filesForNum[i].id, name: filesForNum[i].name, reason: 'duplicate_number' });
        }
      }
    } else {
      for (const f of filesForNum) {
        orphanFiles.push({ number: num, id: f.id, name: f.name, reason: 'missing_caption' });
      }
    }
  }

  for (const num of captionNums) {
    if (!validMediaByNum.has(num)) {
      const cap = captionMap.get(num);
      orphanCaptions.push({
        number: num,
        preview: cap.text.slice(0, 80),
      });
    }
  }

  return {
    pair: selectedPair,
    orphanFiles,
    orphanCaptions,
    invalidMediaFiles,
    duplicateCaptions: duplicates,
    blockedSkipped,
    totalMediaFiles: mediaFiles.length,
    totalCaptions: blocks.length,
  };
}
