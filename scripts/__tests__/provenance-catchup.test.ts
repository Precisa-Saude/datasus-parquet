import { describe, expect, it, vi } from 'vitest';

import { groupListing, type ListedFile } from '../lib/ftp-groups.js';
import {
  buildProvenance,
  EMPTY_SHA256,
  type ProvenanceInput,
  type SourceFile,
} from '../lib/provenance.js';
import {
  buildReconstructedProvenance,
  bytesToDownload,
  type Candidate,
  catchupMarkdown,
  type CertifiedCandidate,
  certifySource,
  checkRecordCount,
  classifyPublished,
  MIN_SOURCE_AGE_HOURS,
  type ProcessOutcome,
  publishedPartitions,
  RECONSTRUCTION_NOTES,
  runCatchup,
  selectCandidates,
} from '../lib/provenance-catchup.js';
import { parquetKey, provenanceKey, type S3Object } from '../lib/s3-objects.js';
import { parseSiaPaFileName, SIA_PA_REGEX } from '../lib/sia-pa-parser.js';

const DIR = '/dissemin/publicos/SIASUS/200801_/Dados';
const CFG = { dir: DIR, fileRegex: SIA_PA_REGEX, parseName: parseSiaPaFileName };
const HOUR = 3600 * 1000;

const SINGLE_SOURCE = {
  bytes: 575335,
  file: 'PAAC0801.dbc',
  ftpPath: `${DIR}/PAAC0801.dbc`,
  mtime: '2026-04-23T21:57:22.789Z',
  sha256: '5'.repeat(64),
};

function prov(source: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    dataset: 'sia-pa',
    generatedAt: '2026-05-21T18:33:02.373Z',
    output: { sha256: 'd'.repeat(64) },
    pipeline: { archiveScript: 'scripts/archive-sia-pa.ts@84df49b', decoder: 'dbc@2.0.0' },
    source,
    ...extra,
  });
}

const LEGADO = prov({ bytes: 0, file: 'PARJ2505.dbc', sha256: EMPTY_SHA256 });
const ATUAL_UNICO = prov(SINGLE_SOURCE);
const ATUAL_DIVIDIDO = prov(null, { sources: [SINGLE_SOURCE, SINGLE_SOURCE] });

function parquetObject(uf: string, ano: number, mes: number, lastModified: string): S3Object {
  return {
    etag: 'e'.repeat(32),
    key: parquetKey('sia-pa', { ano, mes, uf }),
    lastModified,
    size: 1000,
  };
}

function candidate(
  uf: string,
  ano: number,
  mes: number,
  lastModified = '2026-05-01T00:00:00.000Z',
): Candidate {
  return {
    ano,
    label: `${uf} ${ano}-${String(mes).padStart(2, '0')}`,
    mes,
    parquet: parquetObject(uf, ano, mes, lastModified),
    previous: null,
    reason: 'ausente',
    uf,
  };
}

describe('classifyPublished', () => {
  it('formato atual (DBC único ou dividido com `source: null`) não é candidato', () => {
    expect(classifyPublished(ATUAL_UNICO)).toBe('atual');
    expect(classifyPublished(ATUAL_DIVIDIDO)).toBe('atual');
  });

  it('formato inválido de antes de 19/11/2026 é legado (mesmo classificador do emit-provenance)', () => {
    expect(classifyPublished(LEGADO)).toBe('legado');
    expect(classifyPublished(prov({ ...SINGLE_SOURCE, sha256: '' }))).toBe('legado');
    expect(classifyPublished(prov({ ...SINGLE_SOURCE, bytes: 0 }))).toBe('legado');
  });

  it('JSON ilegível ou que não é objeto não é tocado', () => {
    expect(classifyPublished('{')).toBe('ilegivel');
    expect(classifyPublished('null')).toBe('ilegivel');
    expect(classifyPublished('[]')).toBe('ilegivel');
  });
});

describe('seleção', () => {
  const objects: S3Object[] = [
    parquetObject('RJ', 2025, 5, '2026-10-01T16:25:36.000Z'),
    parquetObject('AC', 2008, 1, '2026-04-25T12:32:18.000Z'),
    parquetObject('AC', 2008, 2, '2026-04-25T12:32:18.000Z'),
    parquetObject('AM', 2008, 1, '2026-04-25T12:32:18.000Z'),
    parquetObject('SP', 2023, 1, '2026-04-25T12:32:18.000Z'),
    parquetObject('PR', 2024, 7, '2026-04-25T12:32:18.000Z'),
    parquetObject('MG', 2025, 8, '2026-04-25T12:32:18.000Z'),
    // Provenance sem Parquet e arquivo de outro tipo: ignorados.
    { ...parquetObject('TO', 2020, 1, '2026-04-25T12:32:18.000Z'), key: 'manifest.json' },
  ];
  const published: Record<string, string> = {
    [provenanceKey('sia-pa', { ano: 2025, mes: 5, uf: 'RJ' })]: LEGADO,
    [provenanceKey('sia-pa', { ano: 2008, mes: 2, uf: 'AC' })]: ATUAL_UNICO,
    [provenanceKey('sia-pa', { ano: 2024, mes: 7, uf: 'PR' })]: '{',
    [provenanceKey('sia-pa', { ano: 2025, mes: 8, uf: 'MG' })]: ATUAL_DIVIDIDO,
    [provenanceKey('sia-pa', { ano: 2019, mes: 1, uf: 'TO' })]: ATUAL_UNICO,
  };
  // SP 2023-01 tem a chave listada, mas o espelho local não a trouxe.
  const listed = [
    ...objects,
    ...Object.keys(published).map((key) => ({ ...objects[0]!, key })),
    { ...objects[0]!, key: provenanceKey('sia-pa', { ano: 2023, mes: 1, uf: 'SP' }) },
  ];
  const read = vi.fn((key: string) => published[key] ?? null);
  const partitions = publishedPartitions(listed, 'sia-pa', read);

  it('lista as partições com Parquet e lê só o provenance que o S3 lista', () => {
    expect(partitions.map((p) => `${p.uf} ${p.ano}-${p.mes}`).sort()).toEqual([
      'AC 2008-1',
      'AC 2008-2',
      'AM 2008-1',
      'MG 2025-8',
      'PR 2024-7',
      'RJ 2025-5',
      'SP 2023-1',
    ]);
    expect(partitions.find((p) => p.uf === 'AC' && p.mes === 1)!.provenance).toEqual({
      listed: false,
      text: null,
    });
    expect(read).not.toHaveBeenCalledWith(provenanceKey('sia-pa', { ano: 2008, mes: 1, uf: 'AC' }));
  });

  it('seleciona sem provenance e legado, do mais antigo ao mais novo; pula atual (idempotente), pendente do run e ilegível', () => {
    const pending = new Set(['AM|2008-01']);
    const s = selectCandidates(partitions, pending);
    expect(s.candidates.map((c) => [c.label, c.reason])).toEqual([
      ['AC 2008-01', 'ausente'],
      ['RJ 2025-05', 'legado'],
    ]);
    expect(s.current).toEqual(['AC 2008-02', 'MG 2025-08']);
    expect(s.pending).toEqual(['AM 2008-01']);
    expect(s.unreadable).toEqual(['SP 2023-01', 'PR 2024-07']);
    // O provenance legado substituído fica registrado no marcador.
    expect(s.candidates[1]!.previous).toEqual({
      generatedAt: '2026-05-21T18:33:02.373Z',
      outputSha256: 'd'.repeat(64),
      pipeline: { archiveScript: 'scripts/archive-sia-pa.ts@84df49b', decoder: 'dbc@2.0.0' },
    });
    expect(s.candidates[0]!.previous).toBe(null);
  });

  it('ordem: ano, depois mês, depois UF', () => {
    const many = publishedPartitions(
      [
        parquetObject('AC', 2009, 1, '2026-01-01T00:00:00Z'),
        parquetObject('TO', 2008, 2, '2026-01-01T00:00:00Z'),
        parquetObject('AC', 2008, 2, '2026-01-01T00:00:00Z'),
        parquetObject('TO', 2008, 1, '2026-01-01T00:00:00Z'),
      ],
      'sia-pa',
      () => null,
    );
    expect(selectCandidates(many, new Set()).candidates.map((c) => c.label)).toEqual([
      'TO 2008-01',
      'AC 2008-02',
      'TO 2008-02',
      'AC 2009-01',
    ]);
  });

  it('provenance legado com campos fora do esperado: `previous` guarda só o que é legível', () => {
    const [p] = publishedPartitions(
      [
        parquetObject('AC', 2008, 1, '2026-01-01T00:00:00Z'),
        { ...objects[0]!, key: provenanceKey('sia-pa', { ano: 2008, mes: 1, uf: 'AC' }) },
      ],
      'sia-pa',
      () => JSON.stringify({ generatedAt: 1, output: null, pipeline: 'x', source: { bytes: 0 } }),
    );
    expect(selectCandidates([p!], new Set()).candidates[0]!.previous).toEqual({
      generatedAt: null,
      outputSha256: null,
      pipeline: null,
    });
  });
});

describe('certifySource', () => {
  const lastModified = '2026-04-25T12:00:00.000Z';
  const ok = new Date(Date.parse(lastModified) - MIN_SOURCE_AGE_HOURS * HOUR).toISOString();
  const tooNew = new Date(Date.parse(lastModified) - MIN_SOURCE_AGE_HOURS * HOUR + 60_000);
  const f = (name: string, size: number, mtime: string): ListedFile => ({
    mtime: new Date(mtime),
    name,
    size,
  });
  const groupOf = (files: ListedFile[]) => groupListing(files, CFG)[0];

  it('DBC único: mtime no FTP 24 h antes do Parquet (limite exato) e tamanho igual ao do state', () => {
    const r = certifySource(
      candidate('AC', 2008, 1, lastModified),
      groupOf([f('PAAC0801.dbc', 575335, ok)]),
      { sourceMtime: '1970-01-01T00:00:00.000Z', sourceSize: 575335 },
      DIR,
    );
    expect(r).toEqual({
      certified: {
        ...candidate('AC', 2008, 1, lastModified),
        files: [{ ftpPath: `${DIR}/PAAC0801.dbc`, name: 'PAAC0801.dbc', size: 575335 }],
        ftpNewestMtime: ok,
        stateSourceSize: 575335,
      },
      ok: true,
    });
  });

  it('partição dividida: todas as variantes, na ordem; tamanho é a soma, como no detect-new', () => {
    const r = certifySource(
      candidate('RJ', 2025, 5, lastModified),
      groupOf([f('PARJ2505b.dbc', 20, ok), f('PARJ2505a.dbc', 10, '2025-06-01T00:00:00Z')]),
      { sourceMtime: '1970-01-01T00:00:00.000Z', sourceSize: 30 },
      DIR,
    );
    expect(r.ok && r.certified.files.map((x) => x.name)).toEqual([
      'PARJ2505a.dbc',
      'PARJ2505b.dbc',
    ]);
    expect(r.ok && r.certified.ftpNewestMtime).toBe(ok);
  });

  it('canônico e variantes no FTP: a soma do grupo confere com o state, os arquivos são os do archive (canônico)', () => {
    const r = certifySource(
      candidate('SP', 2013, 1, lastModified),
      groupOf([f('PASP1301.dbc', 30, ok), f('PASP1301a.dbc', 10, ok)]),
      { sourceMtime: '1970-01-01T00:00:00.000Z', sourceSize: 40 },
      DIR,
    );
    expect(r.ok && r.certified.files.map((x) => x.name)).toEqual(['PASP1301.dbc']);
  });

  it('pula "fonte reescrita depois do archive" quando algum DBC é mais novo que Parquet − 24 h', () => {
    const r = certifySource(
      candidate('RJ', 2025, 5, lastModified),
      groupOf([f('PARJ2505a.dbc', 10, ok), f('PARJ2505b.dbc', 20, tooNew.toISOString())]),
      { sourceMtime: '1970-01-01T00:00:00.000Z', sourceSize: 30 },
      DIR,
    );
    expect(r).toEqual({
      ok: false,
      skipped: {
        detail: expect.stringMatching(
          /PARJ2505b\.dbc.*2026-04-24T12:01:00\.000Z.*2026-04-25T12:00:00\.000Z/,
        ),
        label: 'RJ 2025-05',
        reason: 'fonte reescrita depois do archive',
      },
    });
  });

  it('pula "tamanho diferente do state"', () => {
    const r = certifySource(
      candidate('AC', 2008, 1, lastModified),
      groupOf([f('PAAC0801.dbc', 575336, ok)]),
      { sourceMtime: '1970-01-01T00:00:00.000Z', sourceSize: 575335 },
      DIR,
    );
    expect(!r.ok && r.skipped).toEqual({
      detail: '575336 bytes no FTP, 575335 no state',
      label: 'AC 2008-01',
      reason: 'tamanho diferente do state',
    });
  });

  it('pula mtime ilegível, partição fora do FTP, sem entrada no state e grupo sem arquivo do archive', () => {
    const state = { sourceMtime: '1970-01-01T00:00:00.000Z', sourceSize: 1 };
    const c = candidate('AC', 2008, 1, lastModified);
    const reason = (r: ReturnType<typeof certifySource>): string | null =>
      r.ok ? null : r.skipped.reason;
    expect(
      reason(certifySource(c, groupOf([f('PAAC0801.dbc', 1, '1970-01-01T00:00:00Z')]), state, DIR)),
    ).toBe('mtime do FTP ilegível');
    expect(reason(certifySource(c, undefined, state, DIR))).toBe('ausente no FTP');
    expect(reason(certifySource(c, groupOf([f('PAAC0801.dbc', 1, ok)]), undefined, DIR))).toBe(
      'sem entrada no state',
    );
    // Nome com extensão em maiúsculas casa com a regex (case-insensitive), mas
    // não é o arquivo que o archive resolveria.
    expect(reason(certifySource(c, groupOf([f('PAAC0801.DBC', 1, ok)]), state, DIR))).toBe(
      'ausente no FTP',
    );
  });
});

describe('bytesToDownload', () => {
  it('soma só o que não está no cache com o tamanho da listagem', () => {
    const files = [
      { ftpPath: `${DIR}/a`, name: 'a', size: 10 },
      { ftpPath: `${DIR}/b`, name: 'b', size: 20 },
      { ftpPath: `${DIR}/c`, name: 'c', size: 30 },
    ];
    const cached: Record<string, number> = { a: 10, b: 0 };
    expect(bytesToDownload(files, (n) => cached[n] ?? null)).toBe(50);
  });
});

function certified(label: string, size: number): CertifiedCandidate {
  const [uf, comp] = label.split(' ') as [string, string];
  const [ano, mes] = comp.split('-').map(Number) as [number, number];
  return {
    ...candidate(uf, ano, mes),
    files: [{ ftpPath: `${DIR}/x`, name: 'x', size }],
    ftpNewestMtime: '2025-01-01T00:00:00.000Z',
    stateSourceSize: size,
  };
}

describe('runCatchup', () => {
  const GB = 1e9;

  function deps(opts: {
    cached?: Set<string>;
    outcomes?: Record<string, (() => ProcessOutcome) | Error>;
  }) {
    let spent = 0;
    const processed: string[] = [];
    return {
      deps: {
        downloadBytes: (c: CertifiedCandidate) =>
          opts.cached?.has(c.label) ? 0 : c.files[0]!.size,
        process: async (c: CertifiedCandidate): Promise<ProcessOutcome> => {
          processed.push(c.label);
          if (!opts.cached?.has(c.label)) spent += c.files[0]!.size;
          const o = opts.outcomes?.[c.label];
          if (o instanceof Error) throw o;
          return o ? o() : { kind: 'escrito', uploaded: true };
        },
        spentBytes: () => spent,
      },
      processed,
    };
  }

  it('processa na ordem e para antes da partição que estouraria o orçamento, listando as restantes', async () => {
    const list = [
      certified('AC 2008-01', 8 * GB),
      certified('AC 2008-02', 8 * GB),
      certified('AC 2008-03', 8 * GB),
      certified('AC 2008-04', 1),
    ];
    const { deps: d, processed } = deps({});
    const r = await runCatchup(list, 20 * GB, d);
    expect(processed).toEqual(['AC 2008-01', 'AC 2008-02']);
    expect(r.done).toEqual(['AC 2008-01', 'AC 2008-02']);
    expect(r.uploaded).toBe(2);
    expect(r.remaining).toEqual(['AC 2008-03', 'AC 2008-04']);
    expect(r.blockedBy).toEqual({ label: 'AC 2008-03', needed: 8 * GB });
  });

  it('orçamento 0: só o que já está no cache, parando na primeira que precisa baixar', async () => {
    const list = [
      certified('AC 2008-01', 5),
      certified('AC 2008-02', 5),
      certified('AC 2008-03', 5),
    ];
    const { deps: d } = deps({ cached: new Set(['AC 2008-01', 'AC 2008-03']) });
    const r = await runCatchup(list, 0, d);
    expect(r.done).toEqual(['AC 2008-01']);
    expect(r.remaining).toEqual(['AC 2008-02', 'AC 2008-03']);
  });

  it('falha numa partição não interrompe as outras; pulada depois do download conta como pulada', async () => {
    const list = [
      certified('AC 2008-01', 1),
      certified('AC 2008-02', 1),
      certified('AC 2008-03', 1),
      certified('AC 2008-04', 1),
    ];
    const { deps: d, processed } = deps({
      outcomes: {
        'AC 2008-01': new Error('ECONNRESET'),
        'AC 2008-02': () => ({
          detail: '10 linhas no Parquet, 11 nos cabeçalhos',
          kind: 'pulado',
          reason: 'linhas diferentes do cabeçalho dos DBCs',
        }),
        'AC 2008-03': () => ({ kind: 'escrito', uploaded: false }),
      },
    });
    const r = await runCatchup(list, GB, d);
    expect(processed).toHaveLength(4);
    expect(r.failed).toEqual([{ label: 'AC 2008-01', message: 'ECONNRESET' }]);
    expect(r.skipped).toEqual([
      {
        detail: '10 linhas no Parquet, 11 nos cabeçalhos',
        label: 'AC 2008-02',
        reason: 'linhas diferentes do cabeçalho dos DBCs',
      },
    ]);
    expect(r.done).toEqual(['AC 2008-03', 'AC 2008-04']);
    expect(r.uploaded).toBe(1);
    expect(r.remaining).toEqual([]);
    expect(r.blockedBy).toBe(null);
  });

  it('erro que não é Error vira mensagem', async () => {
    const { deps: d } = deps({});
    const r = await runCatchup([certified('AC 2008-01', 1)], GB, {
      ...d,
      process: () => Promise.reject('texto'),
    });
    expect(r.failed).toEqual([{ label: 'AC 2008-01', message: 'texto' }]);
  });
});

describe('checkRecordCount', () => {
  it('linhas do Parquet iguais à soma dos recordCount dos cabeçalhos', () => {
    expect(checkRecordCount(8483346, [4707934, 3775412])).toBe(null);
  });

  it('diferente ou cabeçalho ilegível: pula', () => {
    expect(checkRecordCount(10, [4, 5])).toEqual({
      detail: '10 linhas no Parquet, 9 nos cabeçalhos dos DBCs',
      reason: 'linhas diferentes do cabeçalho dos DBCs',
    });
    expect(checkRecordCount(10, [10, null])).toEqual({
      detail: 'cabeçalho ilegível em DBC da partição',
      reason: 'linhas diferentes do cabeçalho dos DBCs',
    });
  });
});

describe('buildReconstructedProvenance', () => {
  const output: ProvenanceInput['output'] = {
    file: 'ano=2008/uf=AC/mes=01/part.parquet',
    fingerprint: 'v1:23878:AB:CD',
    rows: 23878,
    schema: [{ name: 'PA_CODUNI', type: 'VARCHAR' }],
    sha256: '7'.repeat(64),
  };
  const base = (sources: ProvenanceInput['sources']): ProvenanceInput => ({
    dataset: 'sia-pa',
    generatedAt: '2026-11-19T12:00:00.000Z',
    output,
    partition: { ano: 2008, mes: 1, uf: 'AC' },
    pipeline: {
      archiveScript: 'scripts/archive-sia-pa.ts@abc',
      datasusSdk: '@precisa-saude/datasus-sdk@2.1.1',
      decoder: '@precisa-saude/datasus-dbc@2.0.4',
    },
    sources,
  });
  const c: CertifiedCandidate = {
    ...candidate('AC', 2008, 1, '2026-04-25T12:32:18.000Z'),
    files: [{ ftpPath: `${DIR}/PAAC0801.dbc`, name: 'PAAC0801.dbc', size: 575335 }],
    ftpNewestMtime: '2025-01-01T00:00:00.000Z',
    stateSourceSize: 575335,
  };

  it('DBC único: mesmo corpo do emit-provenance, na mesma ordem, mais o marcador `reconstructed` no fim', () => {
    const input = base({ source: SINGLE_SOURCE as SourceFile });
    const body = buildReconstructedProvenance(input, c, 23878);
    const normal = buildProvenance(input);
    expect(Object.keys(body)).toEqual([...Object.keys(normal), 'reconstructed']);
    expect({ ...body, reconstructed: undefined }).toEqual({ ...normal, reconstructed: undefined });
    expect(body['reconstructed']).toEqual({
      certification: {
        dbcRecordCount: 23878,
        ftpNewestMtime: '2025-01-01T00:00:00.000Z',
        minAgeHours: MIN_SOURCE_AGE_HOURS,
        parquetLastModified: '2026-04-25T12:32:18.000Z',
        stateSourceSize: 575335,
      },
      notes: RECONSTRUCTION_NOTES,
      previous: null,
      reason: 'ausente',
    });
    expect(body['source']).toEqual(SINGLE_SOURCE);
    expect('sources' in body).toBe(false);
  });

  it('partição dividida: `source: null` e `sources`; legado guarda o provenance substituído', () => {
    const previous = {
      generatedAt: '2026-05-21T18:33:02.373Z',
      outputSha256: null,
      pipeline: null,
    };
    const body = buildReconstructedProvenance(
      base({ source: null, sources: [SINGLE_SOURCE, SINGLE_SOURCE] }),
      { ...c, previous, reason: 'legado' },
      1,
    );
    expect(body['source']).toBe(null);
    expect(body['sources']).toHaveLength(2);
    expect(body['reconstructed']).toMatchObject({ previous, reason: 'legado' });
  });
});

describe('catchupMarkdown', () => {
  it('resume emitidas, puladas com motivo, falhas e restantes', () => {
    const md = catchupMarkdown({
      budgetBytes: 20e9,
      certificationSkipped: [
        {
          detail: 'PARJ2505b.dbc …',
          label: 'RJ 2025-05',
          reason: 'fonte reescrita depois do archive',
        },
      ],
      downloadedBytes: 1.5e9,
      dryRun: true,
      report: {
        blockedBy: { label: 'SP 2023-01', needed: 25e9 },
        done: ['AC 2008-01'],
        failed: [{ label: 'AM 2008-01', message: 'ECONNRESET' }],
        remaining: ['SP 2023-01', 'SP 2023-02'],
        skipped: [
          {
            detail: '10 ≠ 9',
            label: 'AC 2008-02',
            reason: 'linhas diferentes do cabeçalho dos DBCs',
          },
        ],
        uploaded: 0,
      },
      selection: {
        candidates: [],
        current: ['MG 2025-08'],
        pending: ['AC 2026-09'],
        unreadable: ['PR 2024-07'],
      },
    });
    expect(md).toContain('## Proveniência retroativa');
    expect(md).toContain('dry-run');
    expect(md).toContain('- Emitidas: 1 (0 enviadas ao S3)');
    expect(md).toContain('- Puladas: 2');
    expect(md).toContain('- Falharam: 1');
    expect(md).toContain('- Restantes (orçamento): 2');
    expect(md).toContain('mais que o orçamento inteiro');
    expect(md).toContain('| RJ 2025-05 | fonte reescrita depois do archive | PARJ2505b.dbc … |');
    expect(md).toContain('| AM 2008-01 | ECONNRESET |');
    expect(md).toContain('- Já no formato atual: 1');
    expect(md).toContain('- Pendentes neste run (fora): 1');
    expect(md).toContain('- Provenance publicado ilegível (não tocado): 1 — PR 2024-07');
  });

  it('sem nada a fazer e sem bloqueio: não lista tabelas vazias', () => {
    const md = catchupMarkdown({
      budgetBytes: 20e9,
      certificationSkipped: [],
      downloadedBytes: 0,
      dryRun: false,
      report: { blockedBy: null, done: [], failed: [], remaining: [], skipped: [], uploaded: 0 },
      selection: { candidates: [], current: [], pending: [], unreadable: [] },
    });
    expect(md).toContain('publicação');
    expect(md).not.toContain('### ');
    expect(md).not.toContain('ilegível');
  });

  it('tabela longa é cortada', () => {
    const skipped = Array.from({ length: 60 }, (_, i) => ({
      detail: 'x',
      label: `AC 2008-${i}`,
      reason: 'tamanho diferente do state' as const,
    }));
    const md = catchupMarkdown({
      budgetBytes: 1,
      certificationSkipped: skipped,
      downloadedBytes: 0,
      dryRun: false,
      report: {
        blockedBy: { label: 'AC 2009-01', needed: 1 },
        done: [],
        failed: [],
        remaining: ['AC 2009-01'],
        skipped: [],
        uploaded: 0,
      },
      selection: { candidates: [], current: [], pending: [], unreadable: [] },
    });
    expect(md).toContain('… e mais 10.');
    expect(md).not.toContain('mais que o orçamento inteiro');
  });
});
