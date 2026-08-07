import { nid, slidePrefix } from '../ids.js';
import { headlineRuns, parseInline } from '../text/runs.js';
import { fitBlock, layoutBlock } from '../text/layout.js';
const W = 1080;
const H = 1080;
const PAD = 76;
const CX = PAD;
const CW = W - 2 * PAD; // 928
const AVATAR = 104;
const PROSE_LH = 1.34;
const HEADER_GAP = 52;
const BODY_PARA_GAP = 36;
function st(tokens, role, weight, size, fill, o = {}) {
    const f = tokens.font(role, weight);
    return {
        family: f.family,
        weight: f.weight,
        italic: f.italic,
        size,
        fill: tokens.color(fill),
        letterSpacingEm: o.ls ?? 0,
        lineHeight: o.lh ?? 1.2,
    };
}
function spec(runs, width, styleOf, align) {
    return { runs, width, styleOf, align };
}
/** aplica o override de tipografia do container ANTES do layout (reflow real). */
function typed(ctx, containerId, styleOf) {
    const t = ctx.typo?.(containerId);
    if (!t)
        return styleOf;
    return (k) => {
        const s = styleOf(k);
        return { ...s, family: t.family ?? s.family, weight: t.weight ?? s.weight, italic: t.family ? false : s.italic };
    };
}
function pushBlock(nodes, prefix, path, block, x, y, z) {
    let li = 0;
    for (const line of block.lines) {
        let ri = 0;
        for (const r of line.runs) {
            nodes.push({
                type: 'glyphrun',
                id: nid(prefix, `${path}.l${li}r${ri}`),
                container: nid(prefix, path),
                z,
                x: x + r.x,
                baselineY: y + r.baselineY,
                text: r.text,
                style: r.style,
            });
            ri++;
        }
        li++;
    }
    return block.height;
}
// ---- nome / @handle derivados do brand kit (display name à parte chega depois) ----
// Sem handle (conta não conectada / kit neutro), cai no placeholder genérico —
// nenhum valor de seed pode aparecer no card.
function displayName(handle) {
    const h = handle.trim().replace(/^@/, '');
    return h || 'Sua conta';
}
function atHandle(handle) {
    const h = handle.trim().replace(/^@/, '');
    return h ? `@${h.toLowerCase()}` : '@suaconta';
}
// ---- estilos de texto do card ----
/**
 * Prosa de thread: uma família sans e uma cor. <em>, <strong> e a keyword do
 * CTA viram apenas peso 700; isso mantém a marcação do LLM sem introduzir a
 * serif itálica do template Editorial no meio de uma frase conversacional.
 */
function proseStyleOf(tokens, size, fill = 'ink') {
    return (k) => {
        switch (k) {
            case 'strong':
            case 'em':
            case 'keyword': return st(tokens, 'body', 700, size, fill, { ls: -0.012, lh: PROSE_LH });
            case 'code': return st(tokens, 'mono', 500, size * 0.92, fill, { lh: PROSE_LH });
            default: return st(tokens, 'body', 400, size, fill, { ls: -0.012, lh: PROSE_LH });
        }
    };
}
/**
 * A `tag` do slide NÃO é um kicker.
 *
 * Ela já foi um rótulo pequeno, cinza e destacado do bloco — e lia como lixo:
 * um texto solto boiando entre o header e a prosa, sem pertencer a nenhum dos
 * dois. Isso é linguagem do template Editorial, e no X não existe etiqueta
 * acima de um tweet. Aqui a tag entra como PRIMEIRA LINHA DA PRÓPRIA PROSA:
 * mesmo tamanho do corpo, mesma cor, só em negrito, colada ao parágrafo que
 * ela abre. Vira abertura de frase, não etiqueta.
 */
/**
 * ESCALA POR OCUPAÇÃO (não por contagem de caracteres).
 *
 * Contar caracteres é um proxy ruim: a mesma contagem quebra em 3 ou em 5
 * linhas dependendo das palavras, e o degrau discreto (52/48/44/40) errava nos
 * dois sentidos — copy curta ficava minúscula boiando num card vazio, copy
 * longa estourava. Aqui o tamanho é DERIVADO da altura real que o texto ocupa:
 * escolhemos o maior corpo da faixa cuja mancha medida ainda cabe em
 * `avail * FILL_TARGET`. Copy curta cresce até preencher, copy longa encolhe
 * sozinha — é o que faz qualquer combinação de persona/padrão "encaixar".
 */
/**
 * Não é "encher o card": é caber com folga. Encher até a borda inflava o tipo —
 * copy curta virava manchete de 60px e o card gritava. 0.86 deixa respiro
 * deliberado; o resto do vazio o balanço óptico distribui.
 */
const FILL_TARGET = 0.86;
/**
 * Faixa tipográfica de cada papel: [mín, máx] em px do design space 1080².
 * Tetos calibrados contra a referência real do X (corpo ~40, CTA ~56 num
 * 1080²) — a faixa existe pra absorver variação de copy, não pra virar
 * manchete quando a copy é curta.
 */
const BODY_RANGE = [32, 42];
const HOOK_RANGE = [42, 60];
const CTA_RANGE = [38, 54];
/**
 * Maior tamanho de `range` cuja composição medida cabe em `avail * FILL_TARGET`.
 * Desce de 2 em 2px (a percepção não distingue 1px nesse corpo) e devolve o
 * mínimo se nem ele couber — aí o shrink/elipse do planText assume.
 */
function fitSize(range, avail, heightAt) {
    const [min, max] = range;
    const budget = avail * FILL_TARGET;
    for (let s = max; s > min; s -= 2) {
        if (heightAt(s) <= budget)
            return s;
    }
    return min;
}
/**
 * BALANÇO ÓPTICO — o resto do vazio não fica todo embaixo.
 *
 * O card é uma moldura fixa 1080², não um screenshot recortado no conteúdo:
 * ancorar tudo no topo deixava ~40% de buraco morto na base e era exatamente
 * isso que fazia a copy "boiar". Empurramos o bloco para baixo por uma FRAÇÃO
 * da sobra — nunca metade (centralizar descola o texto do header e mata a
 * leitura de thread) e nunca zero. Com a faixa de imagem presente a sobra já
 * foi absorvida por ela, então o nudge tende naturalmente a zero.
 */
const BALANCE = 0.42;
/** teto do empurrão: acima disso o texto descola do header e vira outra coisa. */
const BALANCE_MAX = 160;
function balancedTop(top, avail, used) {
    return top + Math.min(BALANCE_MAX, Math.max(0, avail - used) * BALANCE);
}
/** Cabeçalho do card: avatar + nome + @handle + contador (page/total). */
function header(nodes, ctx, prefix, page, total) {
    const { tokens, metrics } = ctx;
    const ay = PAD;
    // avatar: foto do canal; sem conexão, usa inicial legível em vez de um disco
    // vazio. ImageNode com radius = AVATAR/2 → círculo.
    const avatarUrl = tokens.brand.avatarUrl;
    if (avatarUrl) {
        nodes.push({ type: 'image', id: nid(prefix, 'avatar'), z: 6, frame: { x: CX, y: ay, w: AVATAR, h: AVATAR }, src: avatarUrl, fit: 'cover', radius: AVATAR / 2 });
    }
    else {
        nodes.push({ type: 'ellipse', id: nid(prefix, 'avatar'), z: 6, frame: { x: CX, y: ay, w: AVATAR, h: AVATAR }, fill: tokens.color('accentSoft') });
        const initial = displayName(tokens.brand.handle).charAt(0).toUpperCase();
        const initialStyle = st(tokens, 'body', 700, 43, 'ink', { lh: 1 });
        const im = metrics.measure(initial, initialStyle);
        nodes.push({
            type: 'glyphrun',
            id: nid(prefix, 'avatar.initial'),
            z: 7,
            x: CX + AVATAR / 2 - im.width / 2,
            baselineY: ay + AVATAR / 2 + im.ascent / 2 - im.descent / 2,
            text: initial,
            style: initialStyle,
        });
    }
    const tx = CX + AVATAR + 28;
    const nameStyle = st(tokens, 'body', 700, 36, 'ink', { ls: -0.012 });
    const handleStyle = st(tokens, 'body', 400, 28, 'muted');
    const capH = nameStyle.size * 0.72;
    const handleDesc = metrics.measure('Mg', handleStyle).descent;
    const handleDy = 40;
    const inkH = capH + handleDy + handleDesc;
    const nameBaseline = ay + AVATAR / 2 - inkH / 2 + capH;
    const handleBaseline = nameBaseline + handleDy;
    nodes.push({ type: 'glyphrun', id: nid(prefix, 'name'), z: 10, x: tx, baselineY: nameBaseline, text: displayName(tokens.brand.handle), style: nameStyle });
    nodes.push({ type: 'glyphrun', id: nid(prefix, 'handle'), z: 10, x: tx, baselineY: handleBaseline, text: atHandle(tokens.brand.handle), style: handleStyle });
    // contador discreto: navegação, não acento visual.
    if (ctx.settings?.showCounter !== false) {
        const countStyle = st(tokens, 'body', 500, 28, 'muted', { ls: 0.01 });
        const counter = `${page}/${total}`;
        const cw = metrics.measure(counter, countStyle).width;
        nodes.push({ type: 'glyphrun', id: nid(prefix, 'counter'), z: 10, x: W - PAD - cw, baselineY: nameBaseline, text: counter, style: countStyle });
    }
    return ay + AVATAR; // bottom do header
}
const BAND_MAX = 400;
const BAND_MIN = 290;
const BAND_GAP = 44;
/** Faixa de imagem arredondada na base do card (só existe quando o slide tem asset). */
function imageBand(nodes, prefix, src, h) {
    const y = H - PAD - h;
    nodes.push({ type: 'image', id: nid(prefix, 'image'), z: 4, frame: { x: CX, y, w: CW, h }, src, fit: 'cover', radius: 24 });
    return y; // topo da faixa
}
/**
 * O gerador vem escrevendo "-> item" dentro do texto da lista. Isso é ASCII
 * cru no meio de uma peça tipográfica: desalinha, não é marcador de verdade e
 * some quando a linha quebra. O template remove qualquer prefixo desses e
 * desenha o marcador ele mesmo — quem manda no visual da lista é o template,
 * não o LLM.
 */
const LIST_PREFIX = /^\s*(?:->|=>|--|[-–—*•·▸▪])\s+/;
const BULLET = '•';
/** recuo do texto em relação ao marcador; linha quebrada alinha com o TEXTO. */
const bulletIndent = (size) => Math.round(size * 0.95);
/**
 * Mede lead + parágrafos dentro de `avail`. Também é usado com a imagem no
 * tamanho mínimo para descobrir quanto espaço pode ser devolvido a ela.
 */
function planText(ctx, prefix, leadRuns, paragraphs, avail, opts) {
    const { metrics } = ctx;
    const placed = [];
    let cursor = 0;
    if (leadRuns.some((r) => r.text.trim())) {
        const styleOf = typed(ctx, nid(prefix, 'lead'), proseStyleOf(ctx.tokens, opts.leadSize));
        const lb = fitBlock(spec(leadRuns, CW, styleOf), metrics, Math.min(opts.leadMaxH, avail), opts.leadFloor);
        placed.push({ path: 'lead', block: lb, y: cursor, indent: 0 });
        cursor += lb.height;
    }
    const minParaH = opts.bodySize * PROSE_LH;
    const styleOf = proseStyleOf(ctx.tokens, opts.bodySize, opts.bodyFill ?? 'ink');
    const indent = bulletIndent(opts.bodySize);
    paragraphs.forEach(({ runs, tight, bullet }, i) => {
        if (!runs.some((r) => r.text.trim()))
            return;
        const gap = placed.length === 0
            ? 0
            : placed[placed.length - 1].path === 'lead'
                ? opts.leadGap
                : tight
                    ? opts.tightGap
                    : opts.paragraphGap;
        const remaining = avail - cursor - gap;
        if (remaining < minParaH)
            return;
        // item de lista quebra na coluna JÁ RECUADA — assim a 2ª linha alinha com
        // o texto da 1ª, e não por baixo do marcador.
        const w = bullet ? CW - indent : CW;
        const sp = spec(runs, w, typed(ctx, nid(prefix, `para[${i}]`), styleOf));
        let b = layoutBlock(sp, metrics);
        if (b.height > remaining)
            b = fitBlock(sp, metrics, remaining, 0.85);
        placed.push({ path: `para[${i}]`, block: b, y: cursor + gap, indent: bullet ? indent : 0, bullet });
        cursor += gap + b.height;
    });
    return { placed, height: cursor };
}
/**
 * Emite o plano abaixo do header, com o balanço óptico aplicado à sobra.
 * Continua ancorado no topo (leitura de thread) — o nudge só evita o buraco
 * morto na base da moldura fixa.
 */
function textBlock(nodes, ctx, prefix, leadRuns, paragraphs, top, bottom, opts) {
    const avail = bottom - top;
    const { placed, height } = planText(ctx, prefix, leadRuns, paragraphs, avail, opts);
    const base = balancedTop(top, avail, height);
    const markerStyle = proseStyleOf(ctx.tokens, opts.bodySize, 'muted')('ink');
    for (const p of placed) {
        pushBlock(nodes, prefix, p.path, p.block, CX + p.indent, base + p.y, 10);
        // marcador pendurado na coluna, na baseline da PRIMEIRA linha do item
        const first = p.bullet ? p.block.lines[0] : undefined;
        if (first) {
            nodes.push({
                type: 'glyphrun',
                id: nid(prefix, `${p.path}.bullet`),
                container: nid(prefix, p.path),
                z: 10,
                x: CX,
                baselineY: base + p.y + first.baselineY,
                text: BULLET,
                style: markerStyle,
            });
        }
    }
}
/**
 * Converte o corpo do slide (list/paragraphs/stats/cards) em parágrafos.
 * `stats` e `cards` viram PARES EMPILHADOS (rótulo em negrito na primeira
 * linha, valor/corpo na segunda, acoplados por `tight`) em vez de uma frase
 * corrida — ver `Para`.
 */
function paragraphsFrom(slide) {
    if (slide.list)
        return slide.list.map((i) => ({ runs: parseInline(i.replace(LIST_PREFIX, '')), bullet: true }));
    if (slide.paragraphs)
        return slide.paragraphs.map((p) => ({ runs: parseInline(p) }));
    if (slide.stats) {
        return slide.stats.flatMap(([n, t]) => [
            { runs: [{ text: n, key: 'strong' }] },
            { runs: parseInline(t), tight: true },
        ]);
    }
    if (slide.cards) {
        return slide.cards.flatMap((c) => [
            { runs: [{ text: c.title ?? '', key: 'strong' }] },
            { runs: parseInline(c.body ?? ''), tight: true },
        ]);
    }
    return [];
}
// ---------------- COVER ----------------
function buildCover(content, total, ctx) {
    const { tokens } = ctx;
    const prefix = slidePrefix('cover', 0);
    const nodes = [];
    const headerBottom = header(nodes, ctx, prefix, 1, total);
    const lead = parseInline(content.hookCapa);
    const paras = [];
    if (content.labelCapa)
        paras.push({ runs: parseInline(content.labelCapa) });
    const top = headerBottom + HEADER_GAP;
    const avail = H - PAD - top;
    // hook e label escalam JUNTOS: o label é subtítulo do hook, não um corpo fixo.
    const optsAt = (s) => ({
        leadSize: s,
        leadMaxH: avail,
        leadFloor: 0.78,
        bodySize: Math.round(s * 0.42),
        bodyFill: 'muted',
        leadGap: Math.round(s * 0.58),
        paragraphGap: 30,
        tightGap: Math.round(s * 0.22),
    });
    const size = fitSize(HOOK_RANGE, avail, (s) => planText(ctx, prefix, lead, paras, Infinity, optsAt(s)).height);
    textBlock(nodes, ctx, prefix, lead, paras, top, H - PAD, optsAt(size));
    return { role: 'cover', sourceIndex: 0, background: tokens.color('bg'), nodes };
}
// ---------------- BODY ----------------
function buildBody(slide, sourceIndex, page, total, ctx, size) {
    const { tokens } = ctx;
    const prefix = slidePrefix('body', sourceIndex);
    const nodes = [];
    header(nodes, ctx, prefix, page, total);
    const c = bodyComposition(slide, ctx, prefix);
    let bottom = H - PAD;
    if (c.src) {
        // A faixa recebe o que a prosa não usou, entre BAND_MIN e BAND_MAX.
        const availWithMinBand = H - PAD - BAND_MIN - BAND_GAP - c.top;
        const { height } = planText(ctx, prefix, c.lead, c.paragraphs, availWithMinBand, c.optsAt(size));
        const bandH = Math.max(BAND_MIN, Math.min(BAND_MAX, H - PAD - (c.top + height + BAND_GAP)));
        bottom = imageBand(nodes, prefix, c.src, bandH) - BAND_GAP;
    }
    textBlock(nodes, ctx, prefix, c.lead, c.paragraphs, c.top, bottom, c.optsAt(size));
    return { role: 'body', sourceIndex, background: tokens.color('bg'), nodes };
}
/**
 * Composição do body SEM emitir nada — dá pra medir todos os slides antes de
 * desenhar qualquer um. O topo é constante (`header()` sempre devolve
 * PAD+AVATAR), então planejar não exige montar o cabeçalho.
 */
function bodyComposition(slide, ctx, prefix) {
    const hasLegacyHeadline = Boolean(slide.headlineTop || slide.headlineEm || slide.headlineBottom);
    // tag → abertura em negrito da prosa (ver nota acima de proseStyleOf).
    const lead = hasLegacyHeadline
        ? headlineRuns(slide.headlineTop, slide.headlineEm, slide.headlineBottom)
        : slide.tag
            ? [{ text: slide.tag, key: 'strong' }]
            : [];
    const paragraphs = paragraphsFrom(slide);
    const top = PAD + AVATAR + HEADER_GAP;
    const src = slide.image?.assetUrl;
    // `stats`/`cards` já começam com um rótulo em NEGRITO. Colar a tag neles
    // empilharia três negritos seguidos e a tag viraria só mais um rótulo da
    // lista. Nesse caso ela recebe o respiro cheio e volta a ler como abertura;
    // sobre prosa normal continua colada ao parágrafo que abre.
    const bodyStartsBold = Boolean(slide.stats || slide.cards);
    // O gap entre parágrafos acompanha o corpo: com corpo grande, um gap fixo de
    // 36px cola os blocos e a prosa vira um muro.
    const optsAt = (s) => ({
        leadSize: hasLegacyHeadline ? Math.min(52, s + 4) : s,
        leadMaxH: hasLegacyHeadline ? 230 : Math.round(s * PROSE_LH * 2),
        leadFloor: 0.84,
        bodySize: s,
        leadGap: hasLegacyHeadline
            ? Math.round(s * 0.8)
            : bodyStartsBold
                ? Math.max(BODY_PARA_GAP, Math.round(s * 0.82))
                : Math.round(s * 0.3),
        paragraphGap: Math.max(BODY_PARA_GAP, Math.round(s * 0.82)),
        tightGap: Math.round(s * 0.24),
    });
    // Com imagem o corpo é medido contra a caixa que preserva a faixa CHEIA — a
    // faixa só cede altura quando nem o corpo mínimo cabe assim.
    const fitAvail = src ? H - PAD - BAND_MAX - BAND_GAP - top : H - PAD - top;
    return {
        lead,
        paragraphs,
        top,
        src,
        optsAt,
        fit: () => fitSize(BODY_RANGE, fitAvail, (s) => planText(ctx, prefix, lead, paragraphs, Infinity, optsAt(s)).height),
    };
}
// ---------------- CTA ----------------
function buildCta(content, total, ctx) {
    const { tokens } = ctx;
    const prefix = slidePrefix('cta', 0);
    const nodes = [];
    const headerBottom = header(nodes, ctx, prefix, total, total);
    const lead = parseInline(content.ctaText || '');
    const paras = [];
    if (content.ctaSub)
        paras.push({ runs: parseInline(content.ctaSub) });
    const top = headerBottom + HEADER_GAP;
    const avail = H - PAD - top;
    const optsAt = (s) => ({
        leadSize: s,
        leadMaxH: avail,
        leadFloor: 0.78,
        bodySize: Math.round(s * 0.46),
        bodyFill: 'muted',
        leadGap: Math.round(s * 0.56),
        paragraphGap: 30,
        tightGap: Math.round(s * 0.22),
    });
    const size = fitSize(CTA_RANGE, avail, (s) => planText(ctx, prefix, lead, paras, Infinity, optsAt(s)).height);
    textBlock(nodes, ctx, prefix, lead, paras, top, H - PAD, optsAt(size));
    return { role: 'cta', sourceIndex: 0, background: tokens.color('bg'), nodes };
}
export const tweetTemplate = {
    family: 'tweet',
    build(content, ctx) {
        const total = content.slides.length + 2;
        const slides = [];
        // RITMO ÚNICO: um carrossel é um conjunto, não 6 peças avulsas. Dimensionar
        // cada slide isoladamente fazia o corpo pular de tamanho a cada swipe —
        // o slide de copy curta virava manchete ao lado de um slide denso. Medimos
        // TODOS os bodies antes de desenhar e adotamos o MENOR tamanho que serve a
        // todos: o slide mais denso define a escala, e ninguém estoura.
        const bodySize = content.slides.length
            ? Math.min(...content.slides.map((s, i) => bodyComposition(s, ctx, slidePrefix('body', i)).fit()))
            : BODY_RANGE[1];
        slides.push(buildCover(content, total, ctx));
        content.slides.forEach((s, i) => slides.push(buildBody(s, i, i + 2, total, ctx, bodySize)));
        slides.push(buildCta(content, total, ctx));
        return slides;
    },
};
