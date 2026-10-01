out = 'D:/DSH-testing/dsh-remote-gateway/design/_exports/';
Get((n) => {
  if (n.name === '03 Mobile Screens') Export([n.id], 'html-css', out + 'screens-reference.html', { scale: 1, includeHtmlScaffold: true, includeLayerNames: true });
});
Print('exported html-css reference');
