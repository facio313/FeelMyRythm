export function nextPartIndex(key: string, currentIndex: number, lastIndex: number): number {
  if (lastIndex < 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return lastIndex;
  if (key === 'ArrowLeft' || key === 'ArrowUp') {
    return (currentIndex - 1 + lastIndex + 1) % (lastIndex + 1);
  }
  if (key === 'ArrowRight' || key === 'ArrowDown') {
    return (currentIndex + 1) % (lastIndex + 1);
  }
  return -1;
}
