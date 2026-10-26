function gitPath(value: string) {
  if (!value.startsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; ) {
    if (body[index] === '\\') {
      const octal = body.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8));
        index += octal.length + 1;
        continue;
      }
      const escaped = body[index + 1] ?? '';
      const characters: Record<string, string> = {
        t: '\t',
        n: '\n',
        r: '\r',
        '\\': '\\',
        '"': '"',
      };
      bytes.push(...new TextEncoder().encode(characters[escaped] ?? escaped));
      index += 2;
    } else {
      const char = String.fromCodePoint(body.codePointAt(index)!);
      bytes.push(...new TextEncoder().encode(char));
      index += char.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
export function patchForFile(patch: string, path: string): string | undefined {
  return patch
    .split(/(?=^diff --git )/m)
    .find((block) =>
      block
        .split('\n')
        .some(
          (line) =>
            (line.startsWith('+++ ') || line.startsWith('--- ')) &&
            gitPath(line.slice(4)).slice(2) === path,
        ),
    );
}
