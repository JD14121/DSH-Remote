SetVariables({
  'bg.primary': { type: 'color', value: '#0F1115' },
  'bg.secondary': { type: 'color', value: '#151922' },
  'surface.primary': { type: 'color', value: '#1A1F2A' },
  'surface.secondary': { type: 'color', value: '#222836' },
  'surface.hover': { type: 'color', value: '#2A3140' },
  'text.primary': { type: 'color', value: '#E8EAF0' },
  'text.secondary': { type: 'color', value: '#B4BAC8' },
  'text.muted': { type: 'color', value: '#7E8698' },
  'text.inverse': { type: 'color', value: '#0F1115' },
  'border.default': { type: 'color', value: '#2A3140' },
  'border.strong': { type: 'color', value: '#3A4356' },
  'accent.primary': { type: 'color', value: '#5B8DEF' },
  'accent.hover': { type: 'color', value: '#7BA4F5' },
  'status.success': { type: 'color', value: '#3FB27F' },
  'status.warning': { type: 'color', value: '#D9A441' },
  'status.danger': { type: 'color', value: '#E5484D' },
  'status.info': { type: 'color', value: '#5B8DEF' },
  'message.user': { type: 'color', value: '#2A3B5C' },
  'message.assistant': { type: 'color', value: '#1A1F2A' },
  'message.system': { type: 'color', value: '#1E2430' },
  'overlay': { type: 'color', value: '#080A0EE6' },
  'focus': { type: 'color', value: '#7BA4F5' },
  'sp1': { type: 'number', value: 4 },
  'sp2': { type: 'number', value: 8 },
  'sp3': { type: 'number', value: 12 },
  'sp4': { type: 'number', value: 16 },
  'sp5': { type: 'number', value: 20 },
  'sp6': { type: 'number', value: 24 },
  'sp7': { type: 'number', value: 32 },
  'sp8': { type: 'number', value: 40 },
  'r1': { type: 'number', value: 8 },
  'r2': { type: 'number', value: 12 },
  'r3': { type: 'number', value: 16 },
  'r4': { type: 'number', value: 20 },
  'rPill': { type: 'number', value: 999 },
  'touch': { type: 'number', value: 44 },
  'topbarH': { type: 'number', value: 56 },
  'drawerW': { type: 'number', value: 300 },
  'railW': { type: 'number', value: 300 },
  'bannerH': { type: 'number', value: 40 }
});

const section = (name, w, h) => ({
  type: 'frame', name, layout: 'vertical', gap: '$sp6', padding: '$sp6',
  width: w, height: h, fill: '$bg.secondary', cornerRadius: '$r3',
  stroke: '$border.default', strokeWidth: 1, clip: true
});
const label = (name, content, size, color, weight) => ({
  type: 'text', name, content, fontFamily: 'Inter', fontSize: size,
  fontWeight: weight || '400', fill: color, textGrowth: 'fit_content'
});

foundations = Insert(document, {
  type: 'frame', name: '01 Foundations', layout: 'horizontal', gap: '$sp6',
  padding: '$sp8', fill: '$bg.primary', cornerRadius: 24, width: 'fit_content', height: 'fit_content'
});
Insert(foundations, {
  type: 'text', name: 'Foundations Title', content: 'Foundations', fontFamily: 'Inter',
  fontSize: 32, fontWeight: '700', fill: '$text.primary'
});

colorCol = Insert(foundations, {
  type: 'frame', name: 'Color', layout: 'vertical', gap: '$sp3',
  width: 300, fill: '$bg.secondary', cornerRadius: '$r3', padding: '$sp5'
});
Insert(colorCol, label('Color Heading', 'Semantic color', 18, '$text.primary', '600'));
colorSwatches = [
  ['bg.primary', 'Background'],
  ['surface.primary', 'Surface'],
  ['accent.primary', 'Accent'],
  ['status.success', 'Success'],
  ['status.warning', 'Warning'],
  ['status.danger', 'Danger'],
  ['message.user', 'User message'],
  ['message.assistant', 'Assistant message']
];
for (const [token, caption] of colorSwatches) {
  swatchRow = Insert(colorCol, {
    type: 'frame', name: `Swatch ${caption}`, layout: 'horizontal', gap: '$sp3',
    alignItems: 'center', width: 'fill_container', height: 'fit_content'
  });
  Insert(swatchRow, {
    type: 'rectangle', name: `Chip ${caption}`, width: 44, height: 44,
    cornerRadius: '$r2', fill: `$${token}`, stroke: '$border.strong', strokeWidth: 1
  });
  Insert(swatchRow, label(`Label ${caption}`, `${token}  ·  ${caption}`, 13, '$text.secondary'));
}

spacingCol = Insert(foundations, {
  type: 'frame', name: 'Spacing and Radius', layout: 'vertical', gap: '$sp3',
  width: 300, fill: '$bg.secondary', cornerRadius: '$r3', padding: '$sp5'
});
Insert(spacingCol, label('Spacing Heading', 'Spacing scale', 18, '$text.primary', '600'));
for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
  stepRow = Insert(spacingCol, {
    type: 'frame', name: `Spacing ${step}`, layout: 'horizontal', gap: '$sp3',
    alignItems: 'center', width: 'fill_container', height: 28
  });
  Insert(stepRow, {
    type: 'rectangle', name: `Bar ${step}`, width: `$${'sp' + step}`, height: 20,
    cornerRadius: 4, fill: '$accent.primary'
  });
  Insert(stepRow, label(`Spacing Label ${step}`, `sp${step}`, 12, '$text.muted'));
}
Insert(spacingCol, label('Radius Heading', 'Radius scale', 18, '$text.primary', '600'));
radiusRow = Insert(spacingCol, {
  type: 'frame', name: 'Radius Row', layout: 'horizontal', gap: '$sp3',
  alignItems: 'center', width: 'fill_container', height: 'fit_content'
});
for (const [token, size] of [['r1', 44], ['r2', 44], ['r3', 44], ['r4', 44], ['rPill', 44]]) {
  Insert(radiusRow, {
    type: 'rectangle', name: `Radius ${token}`, width: size, height: 44,
    cornerRadius: `$${token}`, fill: '$surface.secondary', stroke: '$border.strong', strokeWidth: 1
  });
}
Insert(spacingCol, label('Radius Note', 'r1 8 · r2 12 · r3 16 · r4 20 · pill 999', 12, '$text.muted'));

typeCol = Insert(foundations, {
  type: 'frame', name: 'Typography', layout: 'vertical', gap: '$sp3',
  width: 320, fill: '$bg.secondary', cornerRadius: '$r3', padding: '$sp5'
});
Insert(typeCol, label('Type Heading', 'Typography', 18, '$text.primary', '600'));
for (const [role, size, weight] of [
  ['display-small', 24, '700'], ['title', 20, '600'], ['subtitle', 17, '600'],
  ['body-strong', 15, '600'], ['body', 15, '400'], ['body-small', 13, '400'],
  ['caption', 12, '400']
]) {
  Insert(typeCol, {
    type: 'text', name: `Type ${role}`, content: `${role} — ${size}px`,
    fontFamily: 'Inter', fontSize: size, fontWeight: weight,
    fill: role === 'caption' || role === 'body-small' ? '$text.muted' : '$text.primary',
    textGrowth: 'fixed-width', width: 280
  });
}
Insert(typeCol, {
  type: 'text', name: 'Type Code', content: 'code — 13px mono',
  fontFamily: 'JetBrains Mono', fontSize: 13, fill: '$text.secondary',
  textGrowth: 'fixed-width', width: 280
});
Insert(typeCol, label('Type Rule', 'Body floor 14px. Chat body 15px. Touch targets 44x44.', 12, '$text.muted'));
