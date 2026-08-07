const registry = new Map();
export function registerTemplate(p) {
    registry.set(p.family, p);
}
export function getTemplate(family) {
    const p = registry.get(family);
    if (p)
        return p;
    // fallback p/ tweet, o carrossel padrão do sistema ('step'/Editorial foi
    // retirado: segue registrado, mas só p/ renderizar conteúdo antigo).
    const fallback = registry.get('tweet');
    if (!fallback)
        throw new Error(`Nenhum template registrado para "${family}"`);
    return fallback;
}
