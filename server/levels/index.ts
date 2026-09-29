import { level1 } from './level1.ts'
import { level2 } from './level2.ts'
import { level3 } from './level3.ts'
import { level4 } from './level4.ts'
import type { LevelDef } from './types.ts'

export * from './types.ts'
export { level1 } from './level1.ts'
export { level2 } from './level2.ts'
export { level3 } from './level3.ts'
export { level4, pendingActions, prunePendingActions } from './level4.ts'

export const levels: Record<1 | 2 | 3 | 4, LevelDef> = {
  1: level1,
  2: level2,
  3: level3,
  4: level4,
}

export function getLevel(id: unknown): LevelDef | undefined {
  if (id === 1 || id === 2 || id === 3 || id === 4) {
    return levels[id]
  }
  return undefined
}
