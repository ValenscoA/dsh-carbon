/**
 * The whale, as React elements.
 *
 * The pixels and the palette come from `lib/core/whale.mjs`, the same module the
 * exported card renders with, so the sprite on the card and the sprite in the
 * hero cannot drift. This file only turns the pixel lists into `<rect>`s and
 * hangs the animation classes on the parts the stylesheet moves.
 *
 * The animation is CSS, not state: a whale that re-renders on a timer would
 * fight the page's 30-second refresh and cost a frame budget for nothing.
 */
import { whaleColors, whaleParts, WHALE_HEIGHT, WHALE_WIDTH } from '../../lib/core/whale.mjs';

function Row({ pixels, fill }) {
  return pixels.map(({ x, y }) => (
    <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={fill} />
  ));
}

/**
 * @param {object} props
 * @param {number} props.load 0..1, the same load the hero tint uses.
 * @param {string} props.title accessible description.
 */
export function Whale({ load = 0, title = 'Whale' }) {
  const colors = whaleColors(load);
  const parts = whaleParts();
  const mood = load < 0.18 ? 'calm' : load < 0.42 ? 'content' : load < 0.7 ? 'warm' : 'hot';

  return (
    <svg
      className={`dshc-whale dshc-whale-${mood}`}
      viewBox={`0 0 ${WHALE_WIDTH} ${WHALE_HEIGHT}`}
      role="img"
      aria-label={title}
      shapeRendering="crispEdges"
      style={{ '--dshc-heat': colors.body }}
    >
      <g className="dshc-whaleFin">
        <Row pixels={parts.fin} fill={colors.fin} />
      </g>
      <g className="dshc-whaleFluke">
        <Row pixels={parts.fluke} fill={colors.fluke} />
      </g>
      <g className="dshc-whaleBody">
        <Row pixels={parts.body} fill={colors.body} />
        <Row pixels={parts.belly} fill={colors.belly} />
        <Row pixels={parts.mouth} fill={colors.mouth} />
      </g>
      <g className="dshc-whaleEye">
        {parts.eye.map(({ x, y, highlight }) => (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width="1"
            height="1"
            fill={highlight ? colors.eyeHighlight : colors.eye}
          />
        ))}
      </g>
      <g className="dshc-whaleSpout">
        <Row pixels={parts.spout} fill={colors.spout} />
      </g>
    </svg>
  );
}
