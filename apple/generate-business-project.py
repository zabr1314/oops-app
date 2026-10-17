#!/usr/bin/env python3
"""Generate the business app pair; keeps the connection-check project separate."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = 'OopsApple'
objects = {}
def uid(name):
    return hashlib.sha1(('business:' + name).encode()).hexdigest()[:24].upper()
def add(key, **fields):
    objects[uid(key)] = fields
    return uid(key)
def ref(path, kind='sourcecode.swift'):
    return add('file:' + path, isa='PBXFileReference', lastKnownFileType=kind, path=path, sourceTree='<group>')
def configs(name, values, base=None):
    ids = []
    for variant in ('Debug', 'Release'):
        settings = dict(values)
        settings.update(SWIFT_OPTIMIZATION_LEVEL='-Onone' if variant == 'Debug' else '-O', DEBUG_INFORMATION_FORMAT='dwarf', ONLY_ACTIVE_ARCH='YES')
        if variant == 'Debug':
            settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) DEBUG'
        extra = {'baseConfigurationReference': base} if base else {}
        ids.append(add(name + ':' + variant, isa='XCBuildConfiguration', buildSettings=settings, name=variant, **extra))
    return add(name + ':configs', isa='XCConfigurationList', buildConfigurations=ids, defaultConfigurationIsVisible=0, defaultConfigurationName='Release')

signing = ref('Configuration/Signing.xcconfig', 'text.xcconfig')
common_files = ['BusinessModel.swift', 'BusinessTransport.swift']
phone_files = ['MobileGateway.swift', 'PhoneAudioProcessing.swift', 'PhoneBusinessStore.swift', 'OopsPhoneApp.swift']
watch_files = ['WatchAudioRecorder.swift', 'WatchBusinessStore.swift', 'OopsWatchApp.swift']
refs = {name: ref('Business/' + name) for name in common_files + phone_files + watch_files}
watch_info = ref('Business/Watch-Info.plist', 'text.plist.xml')
products = {name: add('product:' + name, isa='PBXFileReference', explicitFileType='wrapper.application', includeInIndex=0, path=name + '.app', sourceTree='BUILT_PRODUCTS_DIR') for name in ('OopsPhone', 'OopsWatch')}
project = uid('project')
watch_target = uid('target:OopsWatch')
proxy = add('proxy:watch', isa='PBXContainerItemProxy', containerPortal=project, proxyType=1, remoteGlobalIDString=watch_target, remoteInfo='OopsWatch')
dependency = add('dependency:watch', isa='PBXTargetDependency', target=watch_target, targetProxy=proxy)
embed = add('embed:file', isa='PBXBuildFile', fileRef=products['OopsWatch'], settings={'ATTRIBUTES': ['RemoveHeadersOnCopy']})
embed_phase = add('embed:phase', isa='PBXCopyFilesBuildPhase', buildActionMask=2147483647, dstPath='$(CONTENTS_FOLDER_PATH)/Watch', dstSubfolderSpec=16, files=[embed], name='Embed Watch Content', runOnlyForDeploymentPostprocessing=0)
phone_settings = {
    'CODE_SIGN_STYLE': 'Automatic', 'CURRENT_PROJECT_VERSION': '1', 'MARKETING_VERSION': '0.1',
    'GENERATE_INFOPLIST_FILE': 'YES', 'INFOPLIST_KEY_CFBundleDisplayName': 'Oops',
    'SWIFT_VERSION': '5.0', 'SWIFT_STRICT_CONCURRENCY': 'minimal', 'ENABLE_USER_SCRIPT_SANDBOXING': 'YES',
    'LD_RUNPATH_SEARCH_PATHS': ['$(inherited)', '@executable_path/Frameworks'],
    'PRODUCT_NAME': '$(TARGET_NAME)', 'PRODUCT_BUNDLE_IDENTIFIER': 'com.oops.development.apple',
    'SDKROOT': 'iphoneos', 'SUPPORTED_PLATFORMS': 'iphoneos iphonesimulator', 'IPHONEOS_DEPLOYMENT_TARGET': '26.0',
    'TARGETED_DEVICE_FAMILY': '1', 'INFOPLIST_KEY_UIApplicationSceneManifest_Generation': 'YES',
    'INFOPLIST_KEY_UILaunchScreen_Generation': 'YES', 'INFOPLIST_KEY_UISupportedInterfaceOrientations': 'UIInterfaceOrientationPortrait',
    'INFOPLIST_KEY_NSSpeechRecognitionUsageDescription': 'Oops 在你开启后，使用 iPhone 本机中文识别处理从已配对手表收到的录音。',
}
watch_settings = dict(phone_settings)
for key in ('IPHONEOS_DEPLOYMENT_TARGET', 'INFOPLIST_KEY_UIApplicationSceneManifest_Generation', 'INFOPLIST_KEY_UILaunchScreen_Generation', 'INFOPLIST_KEY_NSSpeechRecognitionUsageDescription'):
    watch_settings.pop(key, None)
watch_settings.update({
    'SDKROOT': 'watchos', 'SUPPORTED_PLATFORMS': 'watchos watchsimulator', 'WATCHOS_DEPLOYMENT_TARGET': '26.0',
    'TARGETED_DEVICE_FAMILY': '4', 'PRODUCT_BUNDLE_IDENTIFIER': 'com.oops.development.apple.watchkitapp',
    'INFOPLIST_FILE': 'Business/Watch-Info.plist', 'INFOPLIST_KEY_WKApplication': 'YES',
    'INFOPLIST_KEY_WKCompanionAppBundleIdentifier': 'com.oops.development.apple',
    'INFOPLIST_KEY_WKRunsIndependentlyOfCompanionApp': 'NO', 'SKIP_INSTALL': 'YES',
    'INFOPLIST_KEY_NSMicrophoneUsageDescription': 'Oops 仅在你确认开始后使用手表麦克风记录会议，并将录音传至你的 iPhone。',
})
for name, files, settings, deps, extra in (
    ('OopsWatch', common_files + watch_files, watch_settings, [], []),
    ('OopsPhone', common_files + phone_files, phone_settings, [dependency], [embed_phase]),
):
    builds = [add(name + ':source:' + f, isa='PBXBuildFile', fileRef=refs[f]) for f in files]
    sources = add(name + ':sources', isa='PBXSourcesBuildPhase', buildActionMask=2147483647, files=builds, runOnlyForDeploymentPostprocessing=0)
    frameworks = add(name + ':frameworks', isa='PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)
    resources = add(name + ':resources', isa='PBXResourcesBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)
    add('target:' + name, isa='PBXNativeTarget', buildConfigurationList=configs(name, settings), buildPhases=[sources, frameworks, resources] + extra, buildRules=[], dependencies=deps, name=name, productName=name, productReference=products[name], productType='com.apple.product-type.application')
products_group = add('products', isa='PBXGroup', children=list(products.values()), name='Products', sourceTree='<group>')
main_group = add('main', isa='PBXGroup', children=[*refs.values(), signing, watch_info, products_group], sourceTree='<group>')
add('project', isa='PBXProject', attributes={'BuildIndependentTargetsInParallel': 'YES', 'LastUpgradeCheck': '2700'}, buildConfigurationList=configs('project', {'CLANG_ENABLE_MODULES': 'YES', 'CLANG_ENABLE_OBJC_ARC': 'YES', 'SWIFT_VERSION': '5.0'}, signing), compatibilityVersion='Xcode 14.0', developmentRegion='en', hasScannedForEncodings=0, knownRegions=['en', 'Base'], mainGroup=main_group, productRefGroup=products_group, projectDirPath='', projectRoot='', targets=[uid('target:OopsPhone'), watch_target])
def encode(value, level=0):
    if isinstance(value, dict):
        return '{\n' + ''.join('\t' * (level + 1) + json.dumps(str(k), ensure_ascii=False) + ' = ' + encode(v, level + 1) + ';\n' for k, v in value.items()) + '\t' * level + '}'
    if isinstance(value, list):
        return '(\n' + ''.join('\t' * (level + 1) + encode(v, level + 1) + ',\n' for v in value) + '\t' * level + ')'
    return str(value) if isinstance(value, int) else json.dumps(value, ensure_ascii=False)
folder = ROOT / (PROJECT + '.xcodeproj')
(folder / 'xcshareddata/xcschemes').mkdir(parents=True, exist_ok=True)
(folder / 'project.pbxproj').write_text('// !$*UTF8*$!\n' + encode({'archiveVersion': 1, 'classes': {}, 'objectVersion': 56, 'objects': objects, 'rootObject': project}) + '\n')
for name in ('OopsPhone', 'OopsWatch'):
    reference = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid("target:" + name)}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:{PROJECT}.xcodeproj"/>'
    (folder / f'xcshareddata/xcschemes/{name}.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="NO" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>\n''')
