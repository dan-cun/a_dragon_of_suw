declare module '*.html' {
  const value: import('bun').HTMLBundle;
  export default value;
}
declare module '*.ps1' {
  const path: string;
  export default path;
}
declare module '*LICENSE' {
  const path: string;
  export default path;
}
declare module '*.ico' {
  const path: string;
  export default path;
}
declare module '*.png' {
  const path: string;
  export default path;
}
