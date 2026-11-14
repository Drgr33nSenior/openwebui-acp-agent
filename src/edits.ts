// Literal replacement only: no regex, newline normalization or fuzzy matching.
export function replaceText(
  current: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (!oldString) throw new Error("old_string must not be empty");
  let count = 0,
    offset = 0;
  for (;;) {
    const index = current.indexOf(oldString, offset);
    if (index < 0) break;
    count++;
    // Overlapping occurrences are ambiguous too. String replacement below uses
    // standard non-overlapping matches, but uniqueness must not guess a target.
    offset = index + 1;
  }
  if (!count || (count !== 1 && !replaceAll))
    throw new Error(
      `old_string matched ${count} occurrences; ${count ? "expected exactly 1 unless replace_all is true" : "expected at least 1"}. Re-read the file and include more surrounding lines from its current content.`,
    );
  // Build from literal slices; '$&', '$1' and backticks in newString are text.
  const pieces = replaceAll
    ? current.split(oldString)
    : [
        current.slice(0, current.indexOf(oldString)),
        current.slice(current.indexOf(oldString) + oldString.length),
      ];
  const length =
    pieces.reduce((sum, piece) => sum + piece.length, 0) +
    (pieces.length - 1) * newString.length;
  if (length > 100000)
    throw new Error(
      "Resulting file exceeds 100,000 characters; split content into smaller files",
    );
  return pieces.join(newString);
}

// 1-based line of the first difference, for the client's follow-along location.
export function firstChangedLine(before: string | null, after: string): number {
  if (before === null) return 1;
  let index = 0;
  const end = Math.min(before.length, after.length);
  while (index < end && before[index] === after[index]) index++;
  let line = 1;
  for (let i = 0; i < index; i++) if (before[i] === "\n") line++;
  return line;
}
