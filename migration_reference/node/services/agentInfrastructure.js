import pool from '../db/index.js'
import { createAgentRunStore } from './agentRunStore.js'
import { createPersistentDraftStore } from './persistentDraftStore.js'

export const runStore = createAgentRunStore(pool)
export const persistentDraftStore = createPersistentDraftStore(pool)
