APP_NAME = RTLSdrAgent
BUNDLE = dist/$(APP_NAME).app

build:
	swift build -c release

run: build
	./.build/release/$(APP_NAME)

app: build
	rm -rf $(BUNDLE)
	mkdir -p $(BUNDLE)/Contents/MacOS
	cp .build/release/$(APP_NAME) $(BUNDLE)/Contents/MacOS/
	cp Resources/Info.plist $(BUNDLE)/Contents/Info.plist
	@echo "Built $(BUNDLE)"

.PHONY: build run app
