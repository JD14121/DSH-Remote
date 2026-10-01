out = 'D:/DSH-testing/dsh-remote-gateway/design/_exports/';
Get((n) => {
  const map = {
    '01 Foundations': '01-foundations',
    '02 Components': '02-components',
    '03 Mobile Screens': '03-mobile-screens',
    '04 States': '04-states',
    '05 Interaction Flows': '05-interaction-flows',
    '03b Tablet & Viewports': '03b-tablet-viewports'
  };
  const slug = map[n.name];
  if (slug) Export([n.id], 'png', out + slug + '.png', { scale: 1 });
  if (n.name === 'T01 Tablet Ready Chat') Export([n.id], 'png', out + 't01-tablet-ready-chat.png', { scale: 1 });
});
Print('exports issued');
