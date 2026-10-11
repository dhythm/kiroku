import { createFileRoute } from '@tanstack/react-router'
import { Notebook } from '../components/notebook'
export const Route = createFileRoute('/')({ component: Notebook })
