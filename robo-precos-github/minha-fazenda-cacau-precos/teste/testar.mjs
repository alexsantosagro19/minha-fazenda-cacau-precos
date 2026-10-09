import fs from 'node:fs/promises';
import { lerPaginaDiaria, lerConab, numeroBR, textoDeHtml } from '../coletar.mjs';
import assert from 'node:assert/strict';
const html = await fs.readFile(new URL('./pagina-exemplo.html', import.meta.url), 'utf8');
const p = lerPaginaDiaria(html);
console.log(JSON.stringify(p));
assert.equal(p.conv.preco, 290); assert.equal(p.conv.variacao, -1.69);
assert.equal(p.cert.preco, 371); assert.equal(p.cert.variacao, -1.33);
assert.equal(p.data, '2026-10-07'); assert.equal(p.ny.preco, 5582); assert.equal(p.ny.contrato, 'Dezembro/26');
// estrutura alternativa (sem tabela, em blocos)
const alt = '<div>Cotação Cacau BR</div><div>Convencional</div><span>BA</span> <span>312,50</span> <span>+0,80%</span> <span>Arroba</span><div>Certificado</div><span>BA</span><span>399,00</span><span>Arroba</span>';
const q = lerPaginaDiaria(alt);
assert.equal(q.conv.preco, 312.5); assert.equal(q.cert.preco, 399);
assert.equal(numeroBR('1.109,00'), 1109); assert.equal(numeroBR('5.582'), 5582); assert.equal(numeroBR('-1,69'), -1.69);
const conab = new TextDecoder('latin1').decode(await fs.readFile(new URL('./conab-exemplo.txt', import.meta.url)));
const s = lerConab(conab);
console.log(JSON.stringify(s));
assert.equal(s.length, 2); assert.equal(s[1].arroba, Math.round(25.2*15*100)/100);
let falhou = false; try{ lerPaginaDiaria('<html>sem tabela</html>'); }catch(e){ falhou = true; }
assert.ok(falhou);
console.log('TODOS OS TESTES PASSARAM');
