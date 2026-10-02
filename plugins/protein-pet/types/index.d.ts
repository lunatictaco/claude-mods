export type Mood = 'folding' | 'misfold' | 'native'

declare module 'claude-code' {
  interface PluginState {
    'protein-pet': { steps: number; folded: number; mood: Mood; isHidden: boolean }
  }
}
