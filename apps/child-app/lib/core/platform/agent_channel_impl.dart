import 'package:flutter/services.dart';

import 'agent_capability_not_implemented_exception.dart';
import 'agent_channel.dart';
import 'agent_channel_constants.dart';

class MethodChannelAgentPlatform implements AgentPlatformChannel {
  MethodChannelAgentPlatform()
      : _channel = const MethodChannel(AgentChannelConstants.channelName);

  final MethodChannel _channel;

  @override
  Future<String> getNativeAppVersion() async {
    return _invoke<String>(AgentChannelConstants.methodGetNativeAppVersion);
  }

  @override
  Future<int> getAndroidSdkInt() async {
    return _invoke<int>(AgentChannelConstants.methodGetAndroidSdkInt);
  }

  Future<T> _invoke<T>(String method, [Map<String, dynamic>? args]) async {
    try {
      final result = await _channel.invokeMethod<T>(method, args);
      if (result == null) {
        throw StateError('Native method "$method" returned null unexpectedly.');
      }
      return result;
    } on MissingPluginException {
      // Thrown when the native side has no handler registered at all for
      // this channel/method — treated the same as an explicit
      // notImplemented() result (see MainActivity.kt).
      throw AgentCapabilityNotImplementedException(method);
    } on PlatformException catch (e) {
      if (e.code == 'NOT_IMPLEMENTED') {
        throw AgentCapabilityNotImplementedException(method);
      }
      rethrow;
    }
  }
}
