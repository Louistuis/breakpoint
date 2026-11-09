/** Original tool silhouettes for the weapon selector. Solid shapes in currentColor, 56 x 32 grid, facing right. */
import type { WeaponId } from '../gameplay/challenges';
import { svg } from './dom';

const VIEW_BOX = '0 0 56 32';

/** Elements with class "bp-ico__hot" take the accent colour while their slot is active (LED, flame, warhead). */
const WEAPON_MARKUP: Record<WeaponId, string> = {
  // Sledgehammer: long handle, wrapped grip, heavy square head.
  hammer:
    '<g transform="rotate(-28 28 16)">' +
    '<rect x="5" y="14.6" width="33" height="2.8" rx="1.2"/>' +
    '<rect x="5" y="13.9" width="9" height="4.2" rx="1.7"/>' +
    '<rect x="36" y="8.5" width="9" height="15" rx="1.2"/>' +
    '<rect x="34.6" y="13.4" width="2" height="5.2"/>' +
    '</g>',

  // Pistol: slide, raked grip, trigger guard, sights.
  pistol:
    '<path d="M12 8h31.5A1.5 1.5 0 0 1 45 9.5V15H12z"/>' +
    '<rect x="14" y="15" width="29" height="2.8" rx=".8"/>' +
    '<path d="M13 15h11.8l-3 13.5H10.2z"/>' +
    '<path d="M12 12.4l-2.6 1.3 2.6 1.3z"/>' +
    '<rect x="41" y="6.5" width="2" height="1.5"/>' +
    '<rect x="13" y="6.5" width="2.6" height="1.5"/>' +
    '<rect x="27" y="17.6" width="1.4" height="3.4" rx=".6"/>' +
    '<path d="M24.6 17.6v3.6a2.6 2.6 0 0 0 2.6 2.6h2.6a2.6 2.6 0 0 0 2.6-2.6v-3.6" fill="none" stroke="currentColor" stroke-width="1.5"/>',

  // Pump shotgun: wedge stock, receiver, barrel over magazine tube, fore-end.
  shotgun:
    '<rect x="20" y="10.4" width="33" height="2.7" rx="1"/>' +
    '<rect x="22" y="14" width="26" height="2.4" rx="1"/>' +
    '<rect x="29" y="13.1" width="12" height="4.8" rx="1.5"/>' +
    '<rect x="13" y="9.8" width="9.6" height="7.8" rx=".9"/>' +
    '<path d="M13.6 10.4v7L3.6 23.6 2.4 15.2z"/>' +
    '<rect x="50.4" y="9.1" width="1.6" height="1.4"/>' +
    '<path d="M15.4 17.4v1.9a2 2 0 0 0 2 2h1.8a2 2 0 0 0 2-2v-1.9" fill="none" stroke="currentColor" stroke-width="1.3"/>',

  // Explosive pack: three bricks under a strap, detonator box with status LED and antenna.
  charge:
    '<rect x="14.6" y="12.4" width="7.8" height="15.6" rx="1"/>' +
    '<rect x="24.1" y="12.4" width="7.8" height="15.6" rx="1"/>' +
    '<rect x="33.6" y="12.4" width="7.8" height="15.6" rx="1"/>' +
    '<rect x="12.6" y="18.2" width="30.8" height="3.6" rx=".7"/>' +
    '<rect x="21.6" y="5.4" width="12.8" height="6" rx=".9"/>' +
    '<path d="M32.4 5.6l5.2-4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<circle cx="38" cy="1.3" r="1.1"/>' +
    '<circle class="bp-ico__hot bp-ico__led" cx="25.4" cy="8.4" r="1.7"/>',

  // Rocket launcher: tube with venturi and muzzle ring, optic, two grips, warhead in the muzzle.
  rocket:
    '<rect x="8" y="10" width="37" height="6.4" rx="1"/>' +
    '<path d="M8.2 10.6L3 8v10.4l5.2-2.6z"/>' +
    '<rect x="44" y="8.7" width="3.4" height="9" rx=".8"/>' +
    '<path d="M22 10V6.2h8.4V10h-1.7V7.9h-5V10z"/>' +
    '<path d="M23.8 16.4h4.4l-1.6 8.2h-4.4z"/>' +
    '<path d="M33 16.4h3.6l-.6 5.8h-3.4z"/>' +
    '<rect x="27.4" y="18" width="6" height="1.2"/>' +
    '<path d="M12.4 16.4h5.2v3.2h-3.6z"/>' +
    '<path class="bp-ico__hot" d="M47.4 10.5h2.3l4 2.7-4 2.7h-2.3z"/>',

  // Blowtorch: upright canister, valve, burner tube and nozzle, flame.
  torch:
    '<rect x="9" y="13.6" width="13" height="15.4" rx="2.2"/>' +
    '<rect x="13" y="9.6" width="5" height="4.4"/>' +
    '<rect x="11" y="6.2" width="24.4" height="3.6" rx="1.2"/>' +
    '<circle cx="9.6" cy="8" r="2.5"/>' +
    '<path d="M35 5.3h4.6a1 1 0 0 1 1 1v3.4a1 1 0 0 1-1 1H35z"/>' +
    '<path d="M24.4 9.6h3.4l-1 6.2h-3.2z"/>' +
    '<path class="bp-ico__hot" d="M42 8c2.6-3.5 7.4-2.7 11.6 0-4.2 2.7-9 3.5-11.6 0z"/>',
};

export function weaponIcon(id: WeaponId, className = 'bp-ico'): SVGSVGElement {
  const el = svg(VIEW_BOX, WEAPON_MARKUP[id], className);
  el.setAttribute('fill', 'currentColor');
  return el;
}
