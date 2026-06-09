declare module "pinyinlite" {
	function pinyinlite(str: string, options?: { keepUnrecognized?: boolean }): string[][];
	export default pinyinlite;
}

declare module "pinyinlite/index_full.js" {
	function pinyinlite(str: string, options?: { keepUnrecognized?: boolean }): string[][];
	export default pinyinlite;
}

