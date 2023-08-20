// @ts-check

'use strict';

const path = require('pathe');
const fs = require('node:fs');
const VirtualModulesPlugin = require('webpack-virtual-modules');
const { NormalModuleReplacementPlugin } = require('webpack');
const {
	getGlobfileContents,
	getGlobfilePath,
	isGlobSpecifier
	// @ts-expect-error: typings don't work for some reason
} = require('glob-imports');
const acorn = require('acorn');
// @ts-expect-error: bad typings
const { walk } = require('estree-walker');
const pkgDirpath = require('pkg-dir');

module.exports = class GlobImportsPlugin {
	/** @type {import('webpack-virtual-modules')} */
	virtualModules;
	/** @type {{ use: Array<any> } | null} */
	ruleToModify;

	#getVirtualModulesCacheFilePath() {
		const packageDirectory = pkgDirpath.sync(process.cwd());
		if (packageDirectory === undefined) {
			throw new Error('Could not find package directory');
		}

		if (fs.existsSync(path.join(packageDirectory, '.next'))) {
			return path.join(
				packageDirectory,
				'.next/cache/webpack/virtual-modules.json'
			);
		}

		return path.join(
			packageDirectory,
			'node_modules/.cache/webpack/virtual-modules.json'
		);
	}

	/**
		@param {{ ruleToModify: { use: Array<any> } }} [options]
	*/
	constructor(options) {
		this.ruleToModify = options?.ruleToModify ?? null;
		const virtualModulesCacheFilePath = this.#getVirtualModulesCacheFilePath();
		/** @type {Record<string, string>} */
		const virtualModulesPluginOptions = {};
		if (fs.existsSync(virtualModulesCacheFilePath)) {
			const cachedVirtualModules = JSON.parse(
				fs.readFileSync(virtualModulesCacheFilePath, 'utf8')
			);

			for (const virtualModulePath of Object.keys(cachedVirtualModules)) {
				virtualModulesPluginOptions[virtualModulePath] = getGlobfileContents({
					globfilePath: virtualModulePath,
					filepathType: 'absolute'
				});
			}
		}

		this.virtualModules = new VirtualModulesPlugin(virtualModulesPluginOptions);
	}

	/**
		Since webpack caches resources, it prevents our dynamic calls to `virtualModules.writeModule` from getting called when resources are cached. Thus, we need to make sure that our virtual modules also get cached to disk.

		@param {string} filepath
		@param {string} contents
	*/
	#writeModule(filepath, contents) {
		this.virtualModules.writeModule(filepath, contents);

		const virtualModulesCacheFilePath = this.#getVirtualModulesCacheFilePath();
		fs.mkdirSync(path.dirname(virtualModulesCacheFilePath), {
			recursive: true
		});

		let cachedVirtualModules;
		if (!fs.existsSync(virtualModulesCacheFilePath)) {
			cachedVirtualModules = {};
		} else {
			cachedVirtualModules = JSON.parse(
				fs.readFileSync(virtualModulesCacheFilePath, 'utf8')
			);
		}

		cachedVirtualModules[filepath] = true;
		fs.writeFileSync(
			virtualModulesCacheFilePath,
			JSON.stringify(cachedVirtualModules)
		);
	}

	/**
		@param {import('webpack').Compiler} compiler
	*/
	apply(compiler) {
		// eslint-disable-next-line unicorn/no-this-assignment -- We need to access the plugin context in a nested functions
		const globImportsPlugin = this;
		this.virtualModules.apply(compiler);

		/**
			Since glob patterns may include an exclamation mark (which is a special character in webpack), instead of stubbing a virtual file, we instead transform the imports in-source to point directly to the virtual file.
		*/
		const loaderRule = this.ruleToModify?.use ?? compiler.options.module.rules;
		loaderRule.unshift(
			/** @type {any} */ ({
				enforce: 'post',
				/** @param {string} id */
				test(id) {
					return (
						!id.includes('/node_modules/') &&
						(id.endsWith('.ts') ||
							id.endsWith('.tsx') ||
							id.endsWith('.js') ||
							id.endsWith('.jsx') ||
							id.endsWith('.cjs') ||
							id.endsWith('.cts') ||
							id.endsWith('.mjs') ||
							id.endsWith('.mts'))
					);
				},
				loader: 'string-replace-loader',
				options: {
					search: /^[\S\s]+$/,
					/**
						@this {import('webpack').LoaderContext<any>}
						@param {string} fileContents
					*/
					replace(fileContents) {
						if (
							!fileContents.includes('glob:') &&
							!fileContents.includes('glob[files]:') &&
							!fileContents.includes('glob[filepaths]:')
						) {
							return fileContents;
						}

						const importerFilePath = this.resourcePath;

						/** @type {Array<{ start: number, end: number, value: string }>} replacements */
						const replacements = [];
						/** @type {acorn.Comment[]} */
						const comments = [];

						const ast = acorn.parse(fileContents, {
							ecmaVersion: 2022,
							sourceType: 'module',
							onComment: comments
						});

						walk(ast, {
							/** @param {any} node */
							enter(node) {
								/** @type {string} */
								let globfileModuleSpecifier;

								if (
									node.type === 'ImportDeclaration' &&
									isGlobSpecifier(node.source.value)
								) {
									globfileModuleSpecifier = node.source.value;
								} else if (
									(node.type === 'ExportNamedDeclaration' ||
										node.type === 'ExportDefaultDeclaration' ||
										node.type === 'ExportAllDeclaration') &&
									node.source &&
									isGlobSpecifier(node.source.value)
								) {
									globfileModuleSpecifier = node.source.value;
								} else {
									return;
								}

								const globfilePath = getGlobfilePath({
									globfileModuleSpecifier,
									importerFilePath
								});

								globImportsPlugin.#writeModule(
									globfilePath,
									getGlobfileContents({
										globfilePath,
										filepathType: 'absolute'
									})
								);

								replacements.push({
									start: node.source.start,
									end: node.source.end,
									value: JSON.stringify(globfilePath)
								});
							}
						});

						/** @type {string[]} */
						const newFileParts = [];
						let previousEnd = 0;
						for (const replacement of replacements) {
							newFileParts.push(
								fileContents.slice(previousEnd, replacement.start),
								replacement.value
							);
							previousEnd = replacement.end;
						}

						newFileParts.push(fileContents.slice(previousEnd));

						const newFileContents = newFileParts.join('');

						return newFileContents;
					}
				}
			})
		);

		new NormalModuleReplacementPlugin(/^glob(?:\[[^:]+])?:/, (resource) => {
			const globfileModuleSpecifier = resource.request;
			const importerFilePath = resource.contextInfo.issuer;

			const globfilePath = getGlobfilePath({
				globfileModuleSpecifier,
				importerFilePath
			});

			const virtualFileContents = getGlobfileContents({
				globfilePath,
				filepathType: 'absolute'
			});

			this.#writeModule(globfilePath, virtualFileContents);

			resource.request = globfilePath;
		}).apply(compiler);
	}
};
