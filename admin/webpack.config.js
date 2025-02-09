const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");
const webpack = require("webpack");
const cors = require("cors");
const HTMLWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

// HTTPS 用証明書の設定
function createHTTPSConfig() {
  // certs フォルダが存在すれば、既存の証明書を使用
  if (fs.existsSync(path.join(__dirname, "certs"))) {
    const key = fs.readFileSync(path.join(__dirname, "certs", "key.pem"));
    const cert = fs.readFileSync(path.join(__dirname, "certs", "cert.pem"));
    return { key, cert };
  } else {
    // 存在しない場合は自己署名証明書を生成
    const pems = selfsigned.generate(
      [
        {
          name: "commonName",
          value: "localhost"
        }
      ],
      {
        days: 365,
        algorithm: "sha256",
        extensions: [
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "localhost" },
              { type: 2, value: "hubs.local" }
            ]
          }
        ]
      }
    );
    fs.mkdirSync(path.join(__dirname, "certs"));
    fs.writeFileSync(path.join(__dirname, "certs", "cert.pem"), pems.cert);
    fs.writeFileSync(path.join(__dirname, "certs", "key.pem"), pems.private);
    return {
      key: pems.private,
      cert: pems.cert
    };
  }
}

const threeExamplesDir = path.resolve(__dirname, "node_modules", "three", "examples");
const basisTranscoderPath = path.resolve(threeExamplesDir, "js", "libs", "basis", "basis_transcoder.js");
const dracoWasmWrapperPath = path.resolve(threeExamplesDir, "js", "libs", "draco", "gltf", "draco_wasm_wrapper.js");
const basisWasmPath = path.resolve(threeExamplesDir, "js", "libs", "basis", "basis_transcoder.wasm");
const dracoWasmPath = path.resolve(threeExamplesDir, "js", "libs", "draco", "gltf", "draco_decoder.wasm");

module.exports = (env, argv) => {
  env = env || {};

  // .env と .defaults.env から環境変数を読み込み
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".defaults.env" });

  // local モードの場合、追加の環境変数を設定
  if (env.local) {
    Object.assign(process.env, {
      HOST: "localhost",
      RETICULUM_SOCKET_SERVER: "localhost",
      CORS_PROXY_SERVER: "hubs-proxy.local:4000",
      NON_CORS_PROXY_DOMAINS: "localhost,dev.reticulum.io",
      BASE_ASSETS_PATH: "https://localhost:8989/",
      RETICULUM_SERVER: "localhost:4000",
      POSTGREST_SERVER: "",
      ITA_SERVER: "turkey",
      TIER: "p1"
    });
  }

  const defaultHostName = "localhost";
  const host = process.env.HOST_IP || defaultHostName;
  const internalHostname = process.env.INTERNAL_HOSTNAME || "localhost";

  return {
    cache: {
      type: "filesystem"
    },
    resolve: {
      alias: {
        // ESM バージョンを強制的に使用するためのエイリアス
        three$: path.resolve(__dirname, "./node_modules/three/build/three.module.js"),
        bitecs$: path.resolve(__dirname, "./node_modules/bitecs/dist/index.mjs"),
        // three の examples 内のライブラリのエイリアス
        "three/examples/js/libs/basis/basis_transcoder.js": basisTranscoderPath,
        "three/examples/js/libs/draco/gltf/draco_wasm_wrapper.js": dracoWasmWrapperPath,
        "three/examples/js/libs/basis/basis_transcoder.wasm": basisWasmPath,
        "three/examples/js/libs/draco/gltf/draco_decoder.wasm": dracoWasmPath
      },
      // symlinks の利用を無効にして、シンボリックリンク経由の解決を避ける
      symlinks: false,
      fallback: {
        fs: false,
        buffer: require.resolve("buffer/"),
        stream: require.resolve("stream-browserify"),
        path: require.resolve("path-browserify")
      },
      extensions: [".ts", ".tsx", ".js", ".jsx"]
    },
    entry: {
      admin: path.join(__dirname, "src", "admin.js")
    },
    output: {
      filename: "assets/js/[name]-[chunkhash].js",
      publicPath: process.env.BASE_ASSETS_PATH || ""
    },
    devtool: argv.mode === "production" ? "source-map" : "inline-source-map",
    devServer: {
      // ※ 静的コンテンツとして "public" フォルダではなく、"dist"（空のディレクトリなど）を指定することで、
      // webpack の出力ファイル（admin.html）を優先的に返すようにする
      static: {
        directory: path.join(__dirname, "dist")
      },
      client: {
        overlay: {
          errors: true,
          warnings: false
        }
      },
      server: {
        type: "https",
        options: createHTTPSConfig()
      },
      host: process.env.HOST_IP || "0.0.0.0",
      port: process.env.PORT || "8989",
      allowedHosts: [host, internalHostname],
      headers: {
        "Access-Control-Allow-Origin": "*"
      },
      // 404 の場合に /admin.html を返す設定
      historyApiFallback: {
        index: "/admin.html"
      },
      setupMiddlewares: (middlewares, { app }) => {
        // ローカル reticulum 経由の場合の CORS 設定
        app.use(cors({ origin: /hubs\.local(:\d*)?$/ }));
        return middlewares;
      }
    },
    performance: {
      // 一部ファイル（メディア、ソースマップなど）は警告対象外にする
      assetFilter(assetFilename) {
        return !/\.(map|png|jpg|gif|glb|webm)$/.test(assetFilename);
      }
    },
    module: {
      rules: [
        {
          test: /\.html$/,
          loader: "html-loader",
          options: {
            minimize: false // HTMLWebpackPlugin で minify するため
          }
        },
        {
          // 特定の JS アセットはそのままコピーするため file-loader を使用
          test: [basisTranscoderPath, dracoWasmWrapperPath],
          loader: "file-loader",
          options: {
            outputPath: "assets/raw-js",
            name: "[name]-[contenthash].[ext]"
          }
        },
        {
          test: /\.js$/,
          loader: "babel-loader",
          options: require("../babel.config"),
          exclude: function (modulePath) {
            return /node_modules/.test(modulePath) && !/node_modules\/hubs/.test(modulePath);
          }
        },
        {
          // TypeScript (.ts/.tsx) の処理
          // Babel により型情報を除去してトランスパイル
          test: /\.tsx?$/,
          loader: "babel-loader",
          options: require("../babel.config"),
          include: [path.resolve(__dirname, "src"), path.resolve(__dirname, "node_modules", "hubs", "src")]
        },
        {
          test: /\.worker\.js$/,
          loader: "worker-loader",
          options: {
            filename: "assets/js/[name]-[contenthash].js",
            publicPath: "/",
            inline: "no-fallback"
          }
        },
        {
          test: /\.(scss|css)$/,
          use: [
            MiniCssExtractPlugin.loader,
            {
              loader: "css-loader",
              options: {
                modules: {
                  localIdentName: "[name]__[local]__[hash:base64:5]",
                  exportLocalsConvention: "camelCase",
                  mode: "global" // グローバルスタイルの場合は global を指定
                }
              }
            },
            "sass-loader"
          ]
        },
        {
          test: /\.(glsl|frag|vert)$/,
          use: { loader: "raw-loader" }
        },
        {
          test: /\.(png|jpg|gif|glb|ogg|mp3|mp4|wav|woff2|webm)$/,
          type: "asset/resource",
          generator: {
            filename: function ({ filename }) {
              let rootPath = path.dirname(filename) + path.sep;
              if (rootPath.startsWith("src" + path.sep)) {
                const parts = rootPath.split(path.sep);
                parts.shift();
                rootPath = parts.join(path.sep);
              }
              if (rootPath.startsWith("node_modules" + path.sep + "hubs" + path.sep + "src" + path.sep)) {
                const parts = rootPath.split(path.sep);
                parts.shift();
                parts.shift();
                parts.shift();
                rootPath = parts.join(path.sep);
              }
              return rootPath + "[name]-[contenthash].[ext]";
            }
          }
        },
        {
          test: /\.(wasm)$/,
          type: "javascript/auto",
          use: {
            loader: "file-loader",
            options: {
              outputPath: "assets/wasm",
              name: "[name]-[contenthash].[ext]"
            }
          }
        }
      ]
    },
    plugins: [
      new webpack.ProvidePlugin({
        process: "process/browser",
        THREE: "three",
        Buffer: ["buffer", "Buffer"]
      }),
      new HTMLWebpackPlugin({
        filename: "admin.html",
        template: path.join(__dirname, "src", "admin.html"),
        scriptLoading: "blocking",
        minify: {
          removeComments: false
        }
      }),
      new CopyWebpackPlugin({
        patterns: [{ from: "src/assets/images/favicon.ico", to: "favicon.ico" }]
      }),
      new MiniCssExtractPlugin({
        filename: "assets/stylesheets/[name]-[contenthash].css"
      }),
      new webpack.DefinePlugin({
        "process.browser": true,
        "process.env": JSON.stringify({
          DISABLE_BRANDING: process.env.DISABLE_BRANDING,
          NODE_ENV: argv.mode,
          BUILD_VERSION: process.env.BUILD_VERSION,
          CONFIGURABLE_SERVICES: process.env.CONFIGURABLE_SERVICES,
          ITA_SERVER: process.env.ITA_SERVER,
          TIER: process.env.TIER,
          RETICULUM_SERVER: process.env.RETICULUM_SERVER,
          CORS_PROXY_SERVER: process.env.CORS_PROXY_SERVER,
          POSTGREST_SERVER: process.env.POSTGREST_SERVER,
          UPLOADS_HOST: process.env.UPLOADS_HOST,
          BASE_ASSETS_PATH: process.env.BASE_ASSETS_PATH
        })
      })
    ]
  };
};
