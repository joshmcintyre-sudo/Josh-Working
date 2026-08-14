import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import styles from '~/styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Loom Designer' },
    ],
    links: [{ rel: 'stylesheet', href: styles }],
  }),
  component: RootDocument,
})

function RootDocument() {
  return (
    <html lang="en" className="h-full">
      <head>
        <HeadContent />
      </head>
      <body className="h-full bg-neutral-950 text-neutral-100 antialiased">
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
