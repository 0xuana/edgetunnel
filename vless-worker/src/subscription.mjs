export function links(config) {
  return config.nodes.map(node => {
    const query = new URLSearchParams({ encryption: 'none', security: 'tls', sni: config.host.replace(/^\[|\]$/g, ''), fp: 'chrome', type: 'ws', host: config.host, path: config.path });
    return `vless://${config.uuid}@${node.server}:${node.port}?${query}#${encodeURIComponent(node.name)}`;
  }).join('\n');
}

export function subscription(config, format) {
  const common = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (format === 'clash') {
    // JSON is valid YAML; serialization also prevents names injecting YAML syntax.
    const proxies = config.nodes.map(node => ({
      name: node.name, type: 'vless', server: node.server.replace(/^\[|\]$/g, ''), port: node.port,
      uuid: config.uuid, network: 'ws', tls: true, udp: true, servername: config.host.replace(/^\[|\]$/g, ''),
      'client-fingerprint': 'chrome', 'skip-cert-verify': false,
      'ws-opts': { path: config.path, headers: { Host: config.host } },
    }));
    const content = { 'mixed-port': 7890, 'allow-lan': false, mode: 'rule', proxies,
      'proxy-groups': [{ name: 'VLESS', type: 'select', proxies: proxies.map(p => p.name) }], rules: ['MATCH,VLESS'] };
    return new Response(JSON.stringify(content, null, 2), { headers: { ...common, 'Content-Type': 'application/yaml; charset=utf-8' } });
  }
  if (format !== 'raw' && format !== 'base64') return new Response('Unsupported format', { status: 400, headers: common });
  const text = links(config);
  const body = format === 'raw' ? text : btoa(text);
  return new Response(body, { headers: { ...common, 'Content-Type': 'text/plain; charset=utf-8' } });
}
