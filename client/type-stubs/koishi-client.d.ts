import type { Component } from 'vue'

export interface Context {
    page(options: {
        name: string
        id?: string
        path: string
        icon?: string
        authority?: number
        order?: number
        component: unknown
    }): void
}

export const send: (name: string, ...args: any[]) => Promise<any>

export const icons: {
    register(name: string, component: Component): void
}
