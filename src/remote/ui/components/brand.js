const SVG_NS = 'http://www.w3.org/2000/svg';

// Shape adapted from the official DSH Desktop icon artwork; the app shell uses
// a monochrome transparent mark to match the supplied DeepSeek Harness header.
const BRAND_MARK_PATH = 'M968.002 326.025C959.5 321.85 955.842 329.804 950.865 333.835C949.162 335.143 947.722 336.834 946.283 338.393C933.859 351.673 919.336 360.407 900.376 359.363C872.649 357.804 848.963 366.525 828.035 387.759C823.586 361.583 808.812 345.951 786.313 335.936C774.536 330.729 762.64 325.51 754.401 314.186C748.645 306.112 747.074 297.127 744.195 288.274C742.36 282.936 740.538 277.465 734.385 276.554C727.718 275.51 725.103 281.112 722.476 285.803C712.006 304.95 707.952 326.039 708.349 347.405C709.26 395.463 729.54 433.742 769.823 460.962C774.404 464.094 775.579 467.212 774.14 471.771C771.394 481.153 768.119 490.257 765.241 499.639C763.406 505.624 760.66 506.933 754.256 504.329C732.154 495.08 713.049 481.417 696.175 464.874C667.524 437.138 641.633 406.536 609.325 382.566C601.733 376.964 594.154 371.758 586.298 366.802C553.33 334.773 590.616 308.464 599.251 305.333C608.282 302.082 602.393 290.877 573.214 291.009C544.048 291.141 517.364 300.906 483.353 313.935C478.389 315.891 473.147 317.318 467.786 318.494C436.917 312.64 404.873 311.332 371.377 315.111C308.332 322.141 257.975 351.964 220.953 402.876C176.471 464.081 166.014 533.624 178.835 606.153C192.302 682.594 231.291 745.887 291.194 795.372C353.328 846.68 424.876 871.813 506.498 866.99C556.076 864.122 611.279 857.489 673.532 804.74C689.23 812.55 705.708 815.681 733.052 818.02C754.111 819.976 774.391 816.976 790.076 813.726C814.674 808.519 812.971 785.726 804.072 781.564C731.995 747.962 747.826 761.638 733.435 750.565C770.06 707.198 825.263 662.139 846.85 516.156C848.553 504.567 847.114 497.273 846.85 487.892C846.718 482.157 848.025 479.95 854.574 479.303C872.623 477.215 890.156 472.273 906.238 463.42C952.938 437.892 971.765 395.965 976.215 345.7C976.875 338.01 976.083 330.069 967.976 326.039L968.002 326.025ZM561.067 778.432C491.222 723.477 457.343 705.374 443.347 706.154C430.263 706.933 432.626 721.918 435.505 731.682C438.515 741.315 442.436 747.962 447.929 756.418C451.718 762.021 454.346 770.345 444.14 776.609C421.641 790.549 382.533 771.918 380.698 771.006C335.174 744.182 297.109 708.757 270.293 660.316C244.389 613.698 229.35 563.685 226.868 510.302C226.208 497.406 230.01 492.847 242.831 490.508C259.704 487.376 277.106 486.729 293.98 489.2C365.264 499.625 425.959 531.523 476.844 582.052C505.878 610.831 527.861 645.213 550.491 678.815C574.561 714.492 600.452 748.49 633.42 776.358C645.066 786.122 654.348 793.548 663.247 799.019C636.431 802.018 591.698 802.666 561.08 778.445L561.067 778.432ZM594.55 562.905C594.55 557.171 599.132 552.625 604.888 552.625C606.195 552.625 607.371 552.876 608.414 553.273C609.853 553.801 611.16 554.581 612.203 555.744C614.038 557.567 615.081 560.17 615.081 562.905C615.081 568.64 610.5 573.185 604.743 573.185C598.987 573.185 594.537 568.627 594.537 562.905H594.55ZM698.539 616.301C691.871 619.037 685.19 621.375 678.787 621.64C668.845 622.155 657.992 618.125 652.103 613.17C642.953 605.479 636.404 601.185 633.658 587.773C632.483 582.039 633.13 573.185 634.186 568.111C636.536 557.171 633.922 550.141 626.212 543.759C619.927 538.553 611.952 537.112 603.185 537.112C599.911 537.112 596.914 535.685 594.682 534.509C591.025 532.686 588.015 528.127 590.893 522.525C591.804 520.701 596.254 516.275 597.297 515.495C609.206 508.716 622.937 510.936 635.625 516.01C647.403 520.833 656.288 529.686 669.109 542.186C682.193 557.289 684.543 561.465 692.003 572.789C697.892 581.642 703.252 590.759 706.909 601.185C709.128 607.699 706.249 613.038 698.539 616.288V616.301Z';

export function createVectorNode(doc, name) {
  return typeof doc.createElementNS === 'function'
    ? doc.createElementNS(SVG_NS, name)
    : doc.createElement(name);
}

function makeSvg(doc, viewBox, className) {
  const icon = createVectorNode(doc, 'svg');
  icon.setAttribute('viewBox', viewBox);
  icon.setAttribute('class', className);
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('focusable', 'false');
  return icon;
}

function addPath(doc, icon, d, fill = 'none') {
  const path = createVectorNode(doc, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', fill);
  if (fill === 'none') {
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  icon.append(path);
}

/** Render the DeepSeek Harness brand lockup used by the session rail and drawer. */
export function renderBrandLockup(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const lockup = doc.createElement('div');
  lockup.className = 'brand-lockup';
  lockup.setAttribute('role', 'img');
  lockup.setAttribute('aria-label', 'DeepSeek Harness');

  const mark = makeSvg(doc, '150 250 850 650', 'brand-lockup__mark');
  const silhouette = createVectorNode(doc, 'path');
  silhouette.setAttribute('d', BRAND_MARK_PATH);
  silhouette.setAttribute('fill', 'currentColor');
  mark.append(silhouette);

  const name = doc.createElement('span');
  name.className = 'brand-lockup__name';
  name.textContent = 'deepseek';
  const badge = doc.createElement('span');
  badge.className = 'brand-lockup__badge';
  badge.textContent = 'HARNESS';
  lockup.append(mark, name, badge);
  return lockup;
}

/** Render the compact panel-shaped session-list toggle shown in the reference. */
export function renderPanelIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'panel-icon');
  addPath(doc, icon, 'M6.5 3.75h11A2.75 2.75 0 0 1 20.25 6.5v11a2.75 2.75 0 0 1-2.75 2.75h-11A2.75 2.75 0 0 1 3.75 17.5v-11A2.75 2.75 0 0 1 6.5 3.75Z');
  addPath(doc, icon, 'M9 4v16');
  return icon;
}

/** Render a clear door-and-arrow glyph for leaving the settings surface. */
export function renderExitIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'settings-exit-icon');
  addPath(doc, icon, 'M10 4.5H6.75A1.75 1.75 0 0 0 5 6.25v11.5a1.75 1.75 0 0 0 1.75 1.75H10');
  addPath(doc, icon, 'M13.5 8.5 17 12l-3.5 3.5');
  addPath(doc, icon, 'M17 12H9');
  return icon;
}

/** Render the restrained overlapping-page copy glyph used by DSH Desktop. */
export function renderCopyIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'message-action-icon');
  addPath(doc, icon, 'M9.25 8.25h7A2.75 2.75 0 0 1 19 11v7a2.75 2.75 0 0 1-2.75 2.75h-7A2.75 2.75 0 0 1 6.5 18v-7a2.75 2.75 0 0 1 2.75-2.75Z');
  addPath(doc, icon, 'M4.75 15.5V7A2.75 2.75 0 0 1 7.5 4.25h8.25');
  return icon;
}

/** Render the small branching path glyph used by DSH Desktop. */
export function renderBranchIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'message-action-icon');
  addPath(doc, icon, 'M4.5 6.5h8a3 3 0 0 1 3 3v5a3 3 0 0 0 3 3H20');
  addPath(doc, icon, 'M12.5 6.5h3a3 3 0 0 1 3 3');
  for (const [cx, cy] of [[4.5, 6.5], [19.5, 9.5], [19.5, 17.5]]) {
    const dot = createVectorNode(doc, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', '1.5');
    dot.setAttribute('fill', 'currentColor');
    icon.append(dot);
  }
  return icon;
}

/** Render a down chevron that turns upward when the details panel is open. */
export function renderDisclosureIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'message-action-icon');
  addPath(doc, icon, 'M6.75 9.25 12 14.5l5.25-5.25');
  return icon;
}

/** Render the clock glyph used beside elapsed turn time. */
export function renderClockIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'message-actions__meta-icon');
  addPath(doc, icon, 'M12 3.75a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 0 0 0-16.5Z');
  addPath(doc, icon, 'M12 7.5v4.8l3.2 1.9');
  return icon;
}

/** Render the compact circular sync mark for connecting and reconnecting states. */
export function renderSyncIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'connection-badge__icon');
  addPath(doc, icon, 'M19.2 8.4A7.5 7.5 0 0 0 6.1 5.7L4.5 7.5');
  addPath(doc, icon, 'M4.5 4.8v2.9h2.9');
  addPath(doc, icon, 'M4.8 15.6a7.5 7.5 0 0 0 13.1 2.7l1.6-1.8');
  addPath(doc, icon, 'M19.5 19.2v-2.9h-2.9');
  return icon;
}

/** Render a broken-link mark for a disconnected Gateway. */
export function renderDisconnectedIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'connection-badge__icon');
  addPath(doc, icon, 'm9 15-1.1 1.1a3.25 3.25 0 0 1-4.6-4.6l3.1-3.1a3.25 3.25 0 0 1 4.6 0');
  addPath(doc, icon, 'm15 9 1.1-1.1a3.25 3.25 0 0 1 4.6 4.6l-3.1 3.1a3.25 3.25 0 0 1-4.6 0');
  addPath(doc, icon, 'm4 20 16-16');
  return icon;
}

/** Render the small database glyph used beside token usage. */
export function renderUsageIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'message-actions__meta-icon');
  addPath(doc, icon, 'M4.5 6.5c0-1.4 3.36-2.5 7.5-2.5s7.5 1.1 7.5 2.5-3.36 2.5-7.5 2.5-7.5-1.1-7.5-2.5Z');
  addPath(doc, icon, 'M4.5 6.5v11c0 1.4 3.36 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-11');
  addPath(doc, icon, 'M4.5 12c0 1.4 3.36 2.5 7.5 2.5s7.5-1.1 7.5-2.5');
  return icon;
}

/** Render the circled plus shown in the desktop New Chat affordance. */
export function renderNewSessionIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'session-new-icon');
  addPath(doc, icon, 'M12 3.75a8.25 8.25 0 1 0 0 16.5 8.25 8.25 0 0 0 0-16.5Z');
  addPath(doc, icon, 'M12 8v8M8 12h8');
  return icon;
}

/** Render the folder states used by the DSH workspace list. */
export function renderWorkspaceIcon(state = 'closed', options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', `workspace-folder-icon workspace-folder-icon--${state}`);
  if (state === 'open' || state === 'active') {
    addPath(doc, icon, 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z');
    addPath(doc, icon, 'M3.75 10h16.5');
  } else {
    addPath(doc, icon, 'M3.5 7.25a1.75 1.75 0 0 1 1.75-1.75h4l2 2h7.5A1.75 1.75 0 0 1 20.5 9.25v8a1.75 1.75 0 0 1-1.75 1.75h-13A2.25 2.25 0 0 1 3.5 16.75Z');
  }
  return icon;
}

/** Render the compact ellipsis shown on workspace headers. */
export function renderMoreIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'workspace-action-icon');
  for (const cx of [5, 12, 19]) {
    const dot = createVectorNode(doc, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', '12');
    dot.setAttribute('r', '1.5');
    dot.setAttribute('fill', 'currentColor');
    icon.append(dot);
  }
  return icon;
}

/** Render the workspace row's create-session plus. */
export function renderWorkspacePlusIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'workspace-action-icon');
  addPath(doc, icon, 'M12 5v14M5 12h14');
  return icon;
}

/** Render the compact paperclip glyph used by the desktop composer. */
export function renderPaperclipIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'composer__icon');
  addPath(doc, icon, 'm8.5 12.5 6.8-6.8a3.75 3.75 0 0 1 5.3 5.3l-8.1 8.1a5.25 5.25 0 0 1-7.4-7.4l8.1-8.1');
  addPath(doc, icon, 'm11 10-6 6a2.25 2.25 0 0 0 3.2 3.2l8.1-8.1');
  return icon;
}

/** Render the centered up-arrow glyph used by the desktop send button. */
export function renderSendIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'composer__icon composer__icon--send');
  addPath(doc, icon, 'M12 19V5');
  addPath(doc, icon, 'm5.5 11.5 6.5-6.5 6.5 6.5');
  return icon;
}

/** Render the small gear used by the drawer's settings entry. */
export function renderGearIcon(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const icon = makeSvg(doc, '0 0 24 24', 'settings-gear-icon');
  addPath(doc, icon, 'M10 3.8h4l.55 2.12c.55.2 1.05.48 1.5.83l2.1-.55 2 3.46-1.55 1.57c.08.56.08 1.14 0 1.7l1.55 1.57-2 3.46-2.1-.55c-.45.35-.95.63-1.5.83L14 20h-4l-.55-2.12c-.55-.2-1.05-.48-1.5-.83l-2.1.55-2-3.46 1.55-1.57a6.2 6.2 0 0 1 0-1.7L3.85 9.3l2-3.46 2.1.55c.45-.35.95-.63 1.5-.83L10 3.8Z');
  const center = createVectorNode(doc, 'circle');
  center.setAttribute('cx', '12');
  center.setAttribute('cy', '11.9');
  center.setAttribute('r', '2.6');
  center.setAttribute('fill', 'none');
  center.setAttribute('stroke', 'currentColor');
  center.setAttribute('stroke-width', '1.7');
  icon.append(center);
  return icon;
}

export function renderActivityIcon(kind, options={}) {
  const doc=options.doc ?? globalThis.document;
  const icon=makeSvg(doc,'0 0 24 24','message-activity__icon');
  if (kind === 'reasoning') {
    // Identical ellipses around a common center give exact 60-degree symmetry.
    for (const angle of [0, 60, 120]) {
      const orbit = createVectorNode(doc, 'ellipse');
      for (const [name, value] of Object.entries({ cx:12, cy:12, rx:9, ry:3.6,
        fill:'none', stroke:'currentColor', 'stroke-width':1.7, transform:`rotate(${angle} 12 12)` })) {
        orbit.setAttribute(name, String(value));
      }
      icon.append(orbit);
    }
    return icon;
  }
  const paths={
    edit:'M4 20l4-1 12-12a2.1 2.1 0 0 0-3-3L5 16l-1 4z M14 7l3 3 M4 22h16',
    command:'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M7 9l3 3-3 3 M13 15h4',
    tool:'M14 4a5 5 0 0 0-6 6L3 15a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3z',
    commentary:'M4 5h16v12H9l-5 4V5z',
    result:'M5 12l4 4L19 6',
  };
  addPath(doc,icon,paths[kind] ?? paths.tool);
  return icon;
}
