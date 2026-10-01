clipped = [];
small = [];
Get((n, ctx) => {
  if (ctx.problems) clipped.push(n.name + ' :: ' + ctx.problems);
  if (n.type === 'ref' || n.type === 'frame') {
    const w = typeof n.width === 'number' ? n.width : null;
    const h = typeof n.height === 'number' ? n.height : null;
    if ((w !== null && w < 44) || (h !== null && h < 44)) {
      const isSized = (w !== null && w < 44) || (h !== null && h < 44);
      if (isSized && /Button|Icon|Chip|Item|Menu|Upload|Send|Cancel|Steer/.test(n.name || '')) {
        small.push((n.name || '(unnamed)') + ' ' + w + 'x' + h);
      }
    }
  }
});
Print('clipped count:', clipped.length);
for (const c of clipped) Print('CLIPPED', c);
Print('undersized interactive count:', small.length);
for (const s of small) Print('SMALL', s);
