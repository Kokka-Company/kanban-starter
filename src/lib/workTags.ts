/**
 * Set-aside blocks: time on the day plan kept for something other than a task, such as
 * a personal break. Auto-plan and task booking leave this time free. Each tag is saved
 * on the block (`tag`, kind `work` in the API), so keep these ids stable. Add your own
 * entries here.
 */
export interface WorkTag {
  name: string
  accent: string
  /** Length of a new block, in minutes. */
  defaultMinutes: number
}

export const WORK_TAGS: Record<string, WorkTag> = {
  personal: { name: 'Personal Break', accent: '#0D9488', defaultMinutes: 60 },
}

export function workTag(tag: string | undefined): WorkTag {
  return (tag && WORK_TAGS[tag]) || { name: tag || 'Set aside', accent: '#0284C7', defaultMinutes: 60 }
}
