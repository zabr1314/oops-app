#!/usr/bin/env python3
"""Generate the small dependency-free Xcode project; does not change signing."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
objects = {}
def uid(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()
def add(key, **fields):
    objects[uid(key)] = fields
    return uid(key)
def ref(path, kind, tree='<group>'):
    return add('file:' + path, isa='PBXFileReference', lastKnownFileType=kind, path=path, sourceTree=tree)
def config_list(name, values):
    ids=[]
    for variant in ['Debug','Release']:
        settings=dict(values)
        if variant=='Debug':
            settings.update({'SWIFT_OPTIMIZATION_LEVEL':'-Onone','ENABLE_TESTABILITY':'YES','DEBUG_INFORMATION_FORMAT':'dwarf','ONLY_ACTIVE_ARCH':'YES'})
        else:
            settings.update({'SWIFT_OPTIMIZATION_LEVEL':'-O','DEBUG_INFORMATION_FORMAT':'dwarf-with-dsym'})
        ids.append(add(f'{name}:{variant}',isa='XCBuildConfiguration',buildSettings=settings,name=variant,**({'baseConfigurationReference': uid('file:Configuration/Signing.xcconfig')} if name == 'project' else {})))
    return add(name+':configs',isa='XCConfigurationList',buildConfigurations=ids,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')

signing_config=ref('Configuration/Signing.xcconfig','text.xcconfig')
shared=[ref('Shared/'+p,'sourcecode.swift') for p in ['ConnectionCheckMessage.swift','ConnectionCheckSession.swift','ConnectionCheckView.swift']]
phone=ref('OopsPhoneCheck/OopsPhoneCheckApp.swift','sourcecode.swift')
watch=ref('OopsWatchCheck/OopsWatchCheckApp.swift','sourcecode.swift')
test=ref('OopsWatchCheckTests/ConnectionCheckTests.swift','sourcecode.swift')
products={}
for name,kind in [('OopsPhoneCheck','wrapper.application'),('OopsWatchCheck','wrapper.application'),('OopsWatchCheckTests','wrapper.cfbundle')]:
    ext='xctest' if name.endswith('Tests') else 'app'
    products[name]=add('product:'+name,isa='PBXFileReference',explicitFileType=kind,includeInIndex=0,path=name+'.'+ext,sourceTree='BUILT_PRODUCTS_DIR')

project=uid('project')
watch_target=uid('target:OopsWatchCheck')
watch_proxy=add('proxy:watch',isa='PBXContainerItemProxy',containerPortal=project,proxyType=1,remoteGlobalIDString=watch_target,remoteInfo='OopsWatchCheck')
watch_dependency=add('dep:watch',isa='PBXTargetDependency',target=watch_target,targetProxy=watch_proxy)
embed_file=add('embed:watch',isa='PBXBuildFile',fileRef=products['OopsWatchCheck'],settings={'ATTRIBUTES':['RemoveHeadersOnCopy']})
embed_phase=add('embed:watch:phase',isa='PBXCopyFilesBuildPhase',buildActionMask=2147483647,dstPath='$(CONTENTS_FOLDER_PATH)/Watch',dstSubfolderSpec=16,files=[embed_file],name='Embed Watch Content',runOnlyForDeploymentPostprocessing=0)

common={
    'CODE_SIGN_STYLE':'Automatic','CURRENT_PROJECT_VERSION':'1','MARKETING_VERSION':'0.1',
    'GENERATE_INFOPLIST_FILE':'YES','INFOPLIST_KEY_CFBundleDisplayName':'Oops 连接检查',
    'SWIFT_VERSION':'5.0','SWIFT_STRICT_CONCURRENCY':'minimal',
    'LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks'],
    'SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SDKROOT':'iphoneos',
    'IPHONEOS_DEPLOYMENT_TARGET':'26.0','TARGETED_DEVICE_FAMILY':'1',
    'PRODUCT_NAME':'$(TARGET_NAME)','PRODUCT_BUNDLE_IDENTIFIER':'com.oops.development.connectioncheck',
    'INFOPLIST_KEY_UIApplicationSceneManifest_Generation':'YES',
    'INFOPLIST_KEY_UILaunchScreen_Generation':'YES',
    'INFOPLIST_KEY_UISupportedInterfaceOrientations':'UIInterfaceOrientationPortrait',
    'ENABLE_USER_SCRIPT_SANDBOXING':'YES',
}
watch_settings=dict(common)
watch_settings.update({
    'SDKROOT':'watchos','SUPPORTED_PLATFORMS':'watchos watchsimulator','WATCHOS_DEPLOYMENT_TARGET':'26.0',
    'TARGETED_DEVICE_FAMILY':'4','PRODUCT_BUNDLE_IDENTIFIER':'com.oops.development.connectioncheck.watchkitapp',
    'INFOPLIST_KEY_WKApplication':'YES','INFOPLIST_KEY_WKCompanionAppBundleIdentifier':'com.oops.development.connectioncheck',
    'INFOPLIST_KEY_WKRunsIndependentlyOfCompanionApp':'NO','SKIP_INSTALL':'YES',
})
for key in ['IPHONEOS_DEPLOYMENT_TARGET','INFOPLIST_KEY_UIApplicationSceneManifest_Generation','INFOPLIST_KEY_UILaunchScreen_Generation']:
    watch_settings.pop(key,None)
test_settings=dict(watch_settings)
test_settings.update({'PRODUCT_BUNDLE_IDENTIFIER':'com.oops.development.connectioncheck.watchkitapp.tests',
    'TEST_HOST':'$(BUILT_PRODUCTS_DIR)/OopsWatchCheck.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/OopsWatchCheck',
    'BUNDLE_LOADER':'$(TEST_HOST)','LD_RUNPATH_SEARCH_PATHS':['$(inherited)','@executable_path/Frameworks','@loader_path/Frameworks']})
for key in ['INFOPLIST_KEY_WKApplication','INFOPLIST_KEY_WKCompanionAppBundleIdentifier','INFOPLIST_KEY_WKRunsIndependentlyOfCompanionApp']:
    test_settings.pop(key,None)

for name,files,settings,deps,extra in [
    ('OopsWatchCheck',shared+[watch],watch_settings,[],[]),
    ('OopsPhoneCheck',shared+[phone],common,[watch_dependency],[embed_phase]),
    ('OopsWatchCheckTests',[test],test_settings,[watch_dependency],[]),
]:
    build_files=[add(name+':source:'+f,isa='PBXBuildFile',fileRef=f) for f in files]
    source_phase=add(name+':sources',isa='PBXSourcesBuildPhase',buildActionMask=2147483647,files=build_files,runOnlyForDeploymentPostprocessing=0)
    framework_phase=add(name+':frameworks',isa='PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[],runOnlyForDeploymentPostprocessing=0)
    resources_phase=add(name+':resources',isa='PBXResourcesBuildPhase',buildActionMask=2147483647,files=[],runOnlyForDeploymentPostprocessing=0)
    add('target:'+name,isa='PBXNativeTarget',buildConfigurationList=config_list(name,settings),buildPhases=[source_phase,framework_phase,resources_phase]+extra,buildRules=[],dependencies=deps,name=name,productName=name,productReference=products[name],productType='com.apple.product-type.bundle.unit-test' if name.endswith('Tests') else 'com.apple.product-type.application')

products_group=add('products',isa='PBXGroup',children=list(products.values()),name='Products',sourceTree='<group>')
main_group=add('main',isa='PBXGroup',children=shared+[phone,watch,test,signing_config,products_group],sourceTree='<group>')
project_settings={
    'CLANG_ENABLE_MODULES':'YES','CLANG_ENABLE_OBJC_ARC':'YES','SWIFT_VERSION':'5.0',
    'GCC_WARN_INHIBIT_ALL_WARNINGS':'NO','SWIFT_EMIT_LOC_STRINGS':'NO',
}
add('project',isa='PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'2700','TargetAttributes':{uid('target:OopsWatchCheckTests'):{'TestTargetID':watch_target}}},buildConfigurationList=config_list('project',project_settings),compatibilityVersion='Xcode 14.0',developmentRegion='en',hasScannedForEncodings=0,knownRegions=['en','Base'],mainGroup=main_group,productRefGroup=products_group,projectDirPath='',projectRoot='',targets=[uid('target:OopsPhoneCheck'),watch_target,uid('target:OopsWatchCheckTests')])

def encode(value, level=0):
    indent='\t'*level
    if isinstance(value,dict):
        return '{\n'+''.join('\t'*(level+1)+json.dumps(str(k),ensure_ascii=False)+' = '+encode(v,level+1)+';\n' for k,v in value.items())+indent+'}'
    if isinstance(value,list):
        return '(\n'+''.join('\t'*(level+1)+encode(v,level+1)+',\n' for v in value)+indent+')'
    return str(value) if isinstance(value,int) else json.dumps(value,ensure_ascii=False)

data={'archiveVersion':1,'classes':{},'objectVersion':56,'objects':objects,'rootObject':project}
(ROOT/'OopsConnectionCheck.xcodeproj/project.pbxproj').write_text('// !$*UTF8*$!\n'+encode(data)+'\n')

for name in ['OopsPhoneCheck','OopsWatchCheck']:
    target_id=uid('target:'+name)
    buildref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target_id}" BuildableName="{name}.app" BlueprintName="{name}" ReferencedContainer="container:OopsConnectionCheck.xcodeproj"/>'
    testref=f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid("target:OopsWatchCheckTests")}" BuildableName="OopsWatchCheckTests.xctest" BlueprintName="OopsWatchCheckTests" ReferencedContainer="container:OopsConnectionCheck.xcodeproj"/>'
    testables=f'<TestableReference skipped="NO">{testref}</TestableReference>' if name=='OopsWatchCheck' else ''
    scheme=f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{buildref}</BuildActionEntry></BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>{testables}</Testables></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildref}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildref}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
'''
    (ROOT/f'OopsConnectionCheck.xcodeproj/xcshareddata/xcschemes/{name}.xcscheme').write_text(scheme)
