/**
 * "Flight deck": the aircraft and spaceflight icon set used by the Aviation
 * theme. Same 16px grid and currentColor rules as the base icons, so every
 * glyph sits in existing buttons unchanged. Names follow components/Icon.tsx;
 * `panel:<id>` entries restyle the sidebar buttons of feature modules.
 */
import type { IconSet } from './index';

const CIRCLE_6 = 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z';

export const FLIGHT_DECK: IconSet = {
  id: 'flight-deck',
  name: 'Flight deck',
  strokeWidth: 1.35,
  icons: {
    // Navigation: an airliner pointing the way you are going.
    back: [{ d: 'M1.5 8c0-.6.9-1 2-1H6l3.5-4.5h1.3L9 7h3l1.2-1.8h1L13.6 8l.6 2.8h-1L12 9H9l1.8 4.5H9.5L6 9H3.5c-1.1 0-2-.4-2-1z', fill: true }],
    forward: [{ d: 'M14.5 8c0-.6-.9-1-2-1H10L6.5 2.5H5.2L7 7H4L2.8 5.2h-1L2.4 8l-.6 2.8h1L4 9h3l-1.8 4.5h1.3L10 9h2.5c1.1 0 2-.4 2-1z', fill: true }],
    // Reload: go around again, a propeller inside the circuit.
    reload: [{ d: 'M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3' }, ...[0, 120, 240].map((a) => ({ d: 'M8 8C7.35 6.9 7.45 5.3 8 4.7c.55.6.65 2.2 0 3.3z', fill: true, accent: true, transform: `rotate(${a} 8 8)` })), { d: 'M8 7.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6z', fill: true }],
    // Stop: abort, an octagonal warning plate.
    stop: [{ d: 'M5.6 2h4.8L14 5.6v4.8L10.4 14H5.6L2 10.4V5.6z' }, { d: 'M6 6l4 4M10 6l-4 4' }],
    // New tab: HUD target box.
    plus: 'M2.5 5V2.5H5M11 2.5h2.5V5M13.5 11v2.5H11M5 13.5H2.5V11M8 5.25v5.5M5.25 8h5.5',
    // Bookmark this page: a guide star.
    star: [{ d: 'M8 1.5Q8.9 7.1 14.5 8 8.9 8.9 8 14.5 7.1 8.9 1.5 8 7.1 7.1 8 1.5z', width: 1.25 }, { d: 'M13 1.5v2.5M11.75 2.75h2.5', width: 1.1 }],
    // Split view: two multi-function displays.
    split: 'M1.5 3.5h5.5v9H1.5zM9 3.5h5.5v9H9zM3 10.5h2.5M10.5 10.5H13',
    sidebar: 'M2.5 3.5h11v9h-11zM10 3.5v9M11.75 6v.01M11.75 8v.01M11.75 10v.01',
    // Downloads: a supply drop under a parachute.
    download: 'M1.5 7.5a6.5 5 0 0 1 13 0M1.5 7.5q1.6-1.1 3.25 0 1.6-1.1 3.25 0 1.6-1.1 3.25 0 1.6-1.1 3.25 0M1.5 7.5l5 4M14.5 7.5l-5 4M8 7.5v4M6.5 11.5h3v2.5h-3z',
    // History: the flight-time clock.
    history: [{ d: CIRCLE_6 }, { d: 'M8 4.5V8l2.5 1.5' }, { d: 'M8 2v1.2M14 8h-1.2M8 14v-1.2M2 8h1.2', width: 1 }],
    // Bookmarks: waypoint flags.
    bookmark: 'M4 14.5V2M4 2.5h8.5L10.5 5l2 2.5H4',
    // Notes: a pilot's kneeboard.
    notes: 'M3.5 3h9v11h-9zM6 1.75h4V4H6zM5.75 6.75h4.5M5.75 9h4.5M5.75 11.25h2.5',
    // Workspaces: a formation, one aircraft per context.
    layers: [{ d: 'M8 1.8 8.5 3.6 10.7 4.8 10.7 5.5 8.5 5 8.4 6.2 9.2 6.9 9.2 7.3 8 7 6.8 7.3 6.8 6.9 7.6 6.2 7.5 5 5.3 5.5 5.3 4.8 7.5 3.6zM3.6 8 4.1 9.8 6.3 11 6.3 11.7 4.1 11.2 4 12.4 4.8 13.1 4.8 13.5 3.6 13.2 2.4 13.5 2.4 13.1 3.2 12.4 3.1 11.2 0.9 11.7 0.9 11 3.1 9.8zM12.4 8 12.9 9.8 15.1 11 15.1 11.7 12.9 11.2 12.8 12.4 13.6 13.1 13.6 13.5 12.4 13.2 11.2 13.5 11.2 13.1 12 12.4 11.9 11.2 9.7 11.7 9.7 11 11.9 9.8z', fill: true }],
    // Settings: the fan face of a turbofan engine.
    settings: [{ d: CIRCLE_6 }, { d: 'M8 6.6C8 4.8 9 3.3 10.6 2.6M9.4 8c1.8 0 3.3 1 4 2.6M8 9.4c0 1.8-1 3.3-2.6 4M6.6 8C4.8 8 3.3 7 2.6 5.4', width: 1.15 }, { d: 'M8 6.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z', fill: true }],
    // Audio: a headset with boom mic.
    speaker: 'M3 9.5V8a5 5 0 0 1 10 0v1.5M2.5 9h2v4h-2zM11.5 9h2v4h-2zM4.5 13c.4.9 1.6 1.5 3 1.5',
    muted: 'M3 9.5V8a5 5 0 0 1 10 0v1.5M2.5 9h2v4h-2zM11.5 9h2v4h-2zM14 2 2 14',
    // Search: a radar scope with a contact.
    search: [{ d: CIRCLE_6 }, { d: 'M8 8 12.25 3.75A6 6 0 0 1 14 8z', fill: true, accent: true, opacity: 0.45 }, { d: 'M8 8l4.25-4.25' }, { d: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', width: 0.9, opacity: 0.55 }, { d: 'M5 10.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z', fill: true, accent: true }],
    // Window: a cabin window.
    window: [{ d: 'M5 1.75h6a2.5 2.5 0 0 1 2.5 2.5v7.5a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1-2.5-2.5v-7.5A2.5 2.5 0 0 1 5 1.75zM6.25 4h3.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-3.5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 6.25 4z' }, { d: 'M6.5 9.5 9 6', accent: true, width: 1.1 }],
    // Private window: a stealth flying wing.
    mask: [{ d: 'M8 3 15 10l-1.9 1-1.3-.9-1.4 1.1-1.2-1L8 12.4l-1.2-1.2-1.2 1-1.4-1.1-1.3.9L1 10z', fill: true }],
    moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5zM12.25 1.5v2.5M11 2.75h2.5',
    // Pinned tab: a navigation beacon.
    pin: 'M8 14.5S3.5 10.1 3.5 6.5a4.5 4.5 0 0 1 9 0c0 3.6-4.5 8-4.5 8zM8 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    // Folders: a hangar.
    folder: 'M1.5 13.5v-6Q8 1.5 14.5 7.5v6zM5 13.5V9.5h6v4M8 9.5v4',
    // Open elsewhere: a jet climbing out with its contrail.
    external: [{ d: 'M14.5 8c0-.6-.9-1-2-1H10L6.5 2.5H5.2L7 7H4L2.8 5.2h-1L2.4 8l-.6 2.8h1L4 9h3l-1.8 4.5h1.3L10 9h2.5c1.1 0 2-.4 2-1z', fill: true, transform: 'translate(9.6 6.4) rotate(-40) scale(0.72) translate(-8 -8)' }, { d: 'M1.75 14.25 4.5 11.5', accent: true, width: 1.5, opacity: 0.9 }, { d: 'M3.6 14.6 5.4 12.8M1.4 12.6 3.2 10.8', accent: true, width: 1, opacity: 0.5 }],
    // Crash and fallback screens: afterburner.
    bolt: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
    // Profile: a pilot's flight helmet and visor.
    user: [{ d: 'M8 1.5A5.25 5.25 0 0 0 2.75 6.75v1.5a5.25 5.25 0 0 0 10.5 0v-1.5A5.25 5.25 0 0 0 8 1.5zM4 14.5h8' }, { d: 'M5 5.75h6V8a3 3 0 0 1-6 0z', fill: true, accent: true, opacity: 0.55 }],
    // Reader and manuals.
    book: 'M2.5 3h4.5a1 1 0 0 1 1 1v9.5a1 1 0 0 0-1-1H2.5zM13.5 3H9a1 1 0 0 0-1 1v9.5a1 1 0 0 1 1-1h4.5z',
    reader: 'M2.5 13.5 4.75 2.5h6.5l2.25 11zM6.25 5.5h3.5M5.75 8h4.5M5.25 10.5h3',

    // Feature-module sidebar buttons.
    'panel:focus': [{ d: CIRCLE_6 }, { d: 'M8 1v3M8 12v3M1 8h3M12 8h3' }, { d: 'M8 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2z', fill: true, accent: true }],
    'panel:privacy': 'M8 1.5 13 3.5v4c0 3-2.2 5.5-5 7-2.8-1.5-5-4-5-7v-4zM5.5 8l1.75 1.75L10.75 6.25',
    'panel:time': [{ d: 'M8 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM6.5 1.5h3M8 1.5v2M12.5 3.5l1 1' }, { d: 'M8 6v3l2 1', accent: true }],
    'panel:notebook': 'M3.5 2.5h9v11h-9zM5.5 2.5v11M7.5 5.5h3M7.5 8h3',
    'panel:library': [{ d: 'M2.5 12.5 6 7.5l3.5 1.75L13.5 3.5', width: 1, opacity: 0.7 }, { d: 'M2.5 11.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM6 6.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM9.5 8.25a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM13.5 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z', fill: true, accent: true }],
    'panel:writer': 'M11.5 2.5l2 2L6 12l-3 1 1-3zM10 4l2 2',
    'panel:calculator': [{ d: CIRCLE_6 }, { d: 'M8 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', opacity: 0.6 }, { d: 'M8 2v2.5M14 8h-2.5M3.75 3.75l1 1M12.25 12.25l-1-1M8 8l2.5-2.5', width: 1.1 }],
    'panel:assistant': [{ d: 'M6.5 5.5h3v5h-3zM5 8h1.5M9.5 8H11M8 5.5V3.5M6.5 2.5a2 2 0 0 0 3 0' }, { d: 'M1.5 6h3.5v4H1.5zM11 6h3.5v4H11z', accent: true }, { d: 'M7 12.5h2', width: 1.1 }],
  },
};
