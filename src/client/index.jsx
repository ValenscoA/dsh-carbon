/**
 * Browser half of dsh-carbon.
 *
 * Registers one sidebar panel and its page. The page reads the same two host
 * routes the CLI's data model already backs (`/dsh-carbon/summary` and
 * `/dsh-carbon/methodology`), so the GUI adds no state of its own and nothing
 * here reaches a model request.
 *
 * Built by `scripts/build-client.mjs` into `lib/client.js`: a
 * `__ModuleLoader__.load({ id, factory })` registration whose only externals
 * are the shell's shared React rows. Do not edit the built file.
 */
import { CarbonPage } from './page.jsx';
import { LeafIcon } from './icons.jsx';
import { en, zh } from './locales.js';
import styles from './styles.css';

export { __test } from './page.jsx';

const NS = 'dsh-carbon';
export const PANEL_ID = 'dsh-carbon';
const PANEL_ORDER = 20;

function CarbonPanelIcon({ size = 16 }) {
  return <LeafIcon size={size} />;
}

export const name = 'dsh-carbon';
export const inject = ['slots', 'locale'];

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-carbon: dictionaries');
  const t = ctx.locale.bind(NS);

  // One stylesheet per plugin instance: the previous instance's effect removes
  // its own node, so a live reload leaves exactly one behind.
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {};
    const style = document.createElement('style');
    style.setAttribute('data-dsh-carbon', 'styles');
    style.textContent = styles;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'dsh-carbon: page styles');

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ localeService: ctx.locale }),
  }, CarbonPage));

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    locale: NS,
    label: () => t('panel'),
  }, CarbonPanelIcon));
}
