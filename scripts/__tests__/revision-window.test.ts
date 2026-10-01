import { describe, expect, it } from 'vitest';

import { competencia, inWindow, REVISION_WINDOW, windowStart } from '../lib/revision-window.js';

describe('competencia', () => {
  it('formata AAAA-MM com zero à esquerda', () => {
    expect(competencia(2026, 7)).toBe('2026-07');
    expect(competencia(2025, 12)).toBe('2025-12');
  });
});

describe('windowStart', () => {
  it('janela de 13 terminando em 2026-07 começa em 2025-07', () => {
    expect(REVISION_WINDOW).toBe(13);
    expect(windowStart('2026-07', REVISION_WINDOW)).toBe('2025-07');
  });

  it('atravessa a virada de ano', () => {
    expect(windowStart('2026-01', 13)).toBe('2025-01');
    expect(windowStart('2026-01', 2)).toBe('2025-12');
  });

  it('janela de 1 é só a competência mais recente', () => {
    expect(windowStart('2026-07', 1)).toBe('2026-07');
  });

  it('tamanho 0 ou negativo desliga a janela', () => {
    expect(windowStart('2026-07', 0)).toBeNull();
    expect(windowStart('2026-07', -3)).toBeNull();
  });

  it('rejeita competência malformada', () => {
    expect(() => windowStart('2026-7', 13)).toThrow(/competência inválida/);
  });
});

describe('inWindow', () => {
  it('inclui o início e o que vem depois', () => {
    expect(inWindow(2025, 7, '2025-07')).toBe(true);
    expect(inWindow(2026, 7, '2025-07')).toBe(true);
  });

  it('exclui o que vem antes', () => {
    expect(inWindow(2025, 6, '2025-07')).toBe(false);
  });

  it('sem janela, nada está dentro', () => {
    expect(inWindow(2026, 7, null)).toBe(false);
  });
});
