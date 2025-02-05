# Dark.js

A lightweight JavaScript plugin to force dark mode on websites that don't natively support it.

## Features

- Automatic dark mode injection
- Configurable color palette
- Smooth transitions
- Image processing controls

## Usage

1. Inject the script into your browser
2. Customize `DarkModeConfig` for specific styling needs

### Configuration Options

- `primaryBackground`: Main background color
- `primaryText`: Primary text color
- `accentColor`: Accent color for links
- `imageAdjustment`: Controls for image processing

## Deployment

Currently used on **[Eyed Out Browser](https://apps.apple.com/app/eyed-out-private-web-browser/id6475011990)** for the "force dark mode" functionality.

### Minification

Use `minify.sh` to minify the dark.js file:

```bash
bash minify.sh dark.js
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Licensing

This project is licensed under the GPL 3.0 License - see the [LICENSE](./LICENSE) file for details.

## Installation

Add the script to your browser's userscript manager or inject via browser extension.

## Compatibility

Works on most modern browsers supporting CSS and JavaScript.