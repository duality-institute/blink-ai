.DEFAULT_GOAL := help

PACKAGE_VERSION := $(shell bun -e 'console.log(require("./package.json").version)')
TARBALL := dualityinstitute-blink-ai-$(PACKAGE_VERSION).tgz

.PHONY: help deps install test check build verify tarball publish icons clean

help:
	@printf '%s\n' \
		'make deps     Install source dependencies' \
		'make install  Build and install blink-ai globally from a tarball' \
		'make test     Run unit tests' \
		'make check    Run type and isolation checks' \
		'make build    Build publishable artifacts' \
		'make verify   Run all release checks' \
		'make tarball  Build a .tgz to install or share' \
		'make publish  Verify, build, and publish @dualityinstitute/blink-ai publicly to npm' \
		'make icons    Regenerate tray icons' \
		'make clean    Remove build output'

deps:
	bun install

install: tarball
	bun install -g "$(CURDIR)/$(TARBALL)"

test:
	bun test

check:
	bun run check

build:
	bun run build

verify:
	bun run verify

tarball: build
	bun pm pack

publish:
	npm publish --access public

icons:
	bun scripts/make-tray-icons.ts

clean:
	bun run clean
