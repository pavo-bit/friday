import 'package:dio/dio.dart';
import '../errors/friday_exception.dart';

class FridayDioClient {
  final Dio _dio;
  String? _bearerToken;

  FridayDioClient({
    required String baseUrl,
    Duration timeout = const Duration(seconds: 10),
    Dio? dio,
  }) : _dio = dio ??
            Dio(
              BaseOptions(
                baseUrl: baseUrl,
                connectTimeout: timeout,
                receiveTimeout: timeout,
                headers: {'Content-Type': 'application/json'},
              ),
            );

  void updateConfig({String? baseUrl, String? bearerToken}) {
    if (baseUrl != null && baseUrl.isNotEmpty) {
      _dio.options.baseUrl = baseUrl;
    }
    if (bearerToken != null) {
      _bearerToken = bearerToken;
    }
  }

  void clearToken() {
    _bearerToken = null;
  }

  Options _authOptions() {
    final headers = <String, dynamic>{};
    if (_bearerToken != null && _bearerToken!.isNotEmpty) {
      headers['Authorization'] = 'Bearer $_bearerToken';
    }
    return Options(headers: headers);
  }

  Future<Map<String, dynamic>> get(String path) async {
    return _wrap(
        () => _dio.get<Map<String, dynamic>>(path, options: _authOptions()));
  }

  Future<Map<String, dynamic>> post(String path,
      {Map<String, dynamic>? data}) async {
    return _wrap(
      () => _dio.post<Map<String, dynamic>>(path,
          data: data, options: _authOptions()),
    );
  }

  Future<Map<String, dynamic>> _wrap(
    Future<Response<Map<String, dynamic>>> Function() call,
  ) async {
    try {
      final res = await call();
      return res.data ?? <String, dynamic>{};
    } on DioException catch (e) {
      final code = e.response?.statusCode;
      if (code == 401 || code == 403) {
        throw const AuthenticationException();
      }
      if (e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.connectionError ||
          e.type == DioExceptionType.receiveTimeout) {
        throw const OfflineBrainException();
      }
      final serverMsg = e.response?.data is Map
          ? (e.response?.data as Map)['error']?.toString()
          : null;
      throw NetworkException(
        serverMsg ?? e.message ?? 'Network request failed',
        statusCode: code,
      );
    }
  }
}
