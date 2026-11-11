import { useEffect, useRef } from 'react';

export function ScoreImage({ blob, name }: { blob: Blob; name: string }) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const url = URL.createObjectURL(blob);
    image.src = url;
    return () => {
      image.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return <img ref={imageRef} className="score-image" alt={name} draggable={false} />;
}
