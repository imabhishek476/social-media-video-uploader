import { useRef, useState, type PointerEvent } from 'react';
import Box from '@mui/material/Box';

export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Draws the facecam box over the source video and, in edit mode, lets the
 * user drag a new one. Coordinates are fractions of the video area. The
 * bottom 40px (native controls) are excluded from the drawing surface.
 */
export function FacecamOverlay({ box, editing, onDraw }: { box: NormBox | null; editing: boolean; onDraw: (b: NormBox) => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const point = (e: PointerEvent) => {
    const r = surface.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const shown: NormBox | null = drag
    ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
    : box;

  return (
    <Box
      ref={surface}
      sx={{ position: 'absolute', inset: 0, bottom: 40, cursor: editing ? 'crosshair' : 'default', pointerEvents: editing ? 'auto' : 'none', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (!editing) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = point(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, ...(({ x, y }) => ({ x1: x, y1: y }))(point(e)) })}
      onPointerUp={() => {
        if (shown && drag && shown.w > 0.03 && shown.h > 0.03) onDraw(shown);
        setDrag(null);
      }}
    >
      {shown && (
        <Box
          sx={{
            position: 'absolute',
            left: `${shown.x * 100}%`,
            top: `${shown.y * 100}%`,
            width: `${shown.w * 100}%`,
            height: `${shown.h * 100}%`,
            border: '2px solid',
            borderColor: editing ? 'warning.main' : 'success.main',
            bgcolor: editing ? 'rgba(255,167,38,0.15)' : 'transparent',
            pointerEvents: 'none',
          }}
        >
          <Box component="span" sx={{ position: 'absolute', top: -20, left: 0, fontSize: 11, px: 0.5, bgcolor: editing ? 'warning.main' : 'success.main', color: 'common.black', borderRadius: 0.5 }}>
            facecam
          </Box>
        </Box>
      )}
    </Box>
  );
}
