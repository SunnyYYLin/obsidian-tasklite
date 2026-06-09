declare module "pinyinlite" {
	function pinyinlite(str: string, options?: { keepUnrecognized?: boolean }): string[][];
	export default pinyinlite;
}
