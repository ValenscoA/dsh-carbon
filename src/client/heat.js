/**
 * The heat scale, re-exported for the browser bundle.
 *
 * The implementation lives in `lib/core/heat.mjs` because the server draws the
 * same colours into the exported card and badge; this module exists so the
 * client imports a stable local path.
 */
export {
  GREEN_AT,
  RED_AT,
  heatLoad,
  heatRamp,
  heatTone,
  ratioTone,
  whaleMood,
} from '../../lib/core/heat.mjs';
