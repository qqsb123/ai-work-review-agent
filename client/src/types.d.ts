declare module 'html2pdf.js' {
  const html2pdf: () => {
    set(options: Record<string, unknown>): any
    from(element: HTMLElement): any
    save(): Promise<void>
  }
  export default html2pdf
}
