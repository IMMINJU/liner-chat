---
description: 5개 캐논 시드로 Sonnet 친족 추천을 직접 호출해 sanity check.
---

`scripts/test-kinship.ts`를 실행한다:

```bash
pnpm tsx scripts/test-kinship.ts
```

출력에서 각 시드별로:

- `lineage_notes`가 청취자 프로파일에 맞는 톤인지 (Creep + obscure는 deep cut 방향, mainstream은 입문급 방향)
- 카테고리별 카운트가 최소치(≥3/≥3/≥2/≥3) 충족하는지
- `kinship` 카테고리에 시대/장르 가로지름이 있는지
- `link_dimensions`에 `melody`/`progression`/`vocal_style` 등 다양한 차원이 활용되는지
- 시드 A (Tame Impala Elephant): kinship에 John Lennon "Well Well Well" 또는 그 시기 곡 등장 여부
- 시드 B (Sex Pistols God Save the Queen): Beatles "Birthday" (1968) 또는 유사 펑크 폭발 곡
- 시드 C (Doors LA Woman): Dire Straits "Sultans of Swing" 또는 동급 내러티브 곡
- 시드 D (Dire Straits Sultans of Swing): Bob Dylan "Things Have Changed" 또는 vocal_style 친족

결과를 정리해서 보고. 기대치에서 벗어나면 [docs/kinship-prompt.md](../../docs/kinship-prompt.md)의 프롬프트 본문을 점검할 후보로 표시.

`ANTHROPIC_API_KEY`가 환경에 있어야 한다. `.env.local`만 있고 환경 변수가 없다면 `node --env-file=.env.local --import tsx scripts/test-kinship.ts` 로도 가능.
