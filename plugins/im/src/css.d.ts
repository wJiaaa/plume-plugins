/** 插件构建把 CSS 当作字符串，界面入口负责挂载。 */
declare module "*.css" {
	const css: string;
	export default css;
}
