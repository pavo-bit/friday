import '../core/networking/friday_dio_client.dart';

class CompanionApiService {
  final FridayDioClient _dio;

  CompanionApiService(this._dio);

  // ---- Tasks & Presentations ----
  Future<Map<String, dynamic>> submitTask(String text, {String? conversationId}) {
    return _dio.post('/friday/tasks', data: {
      'text': text,
      if (conversationId != null) 'conversationId': conversationId,
    });
  }

  Future<List<Map<String, dynamic>>> listTasks({int limit = 20}) async {
    final res = await _dio.get('/friday/tasks?limit=$limit');
    return List<Map<String, dynamic>>.from(res['tasks'] ?? const []);
  }

  Future<Map<String, dynamic>> getTaskDetail(String taskId) {
    return _dio.get('/friday/tasks/$taskId');
  }

  Future<List<Map<String, dynamic>>> listPresentations({int limit = 20}) async {
    final res = await _dio.get('/friday/presentations?limit=$limit');
    return List<Map<String, dynamic>>.from(res['presentations'] ?? const []);
  }

  Future<Map<String, dynamic>> getTaskPresentation(String taskId) {
    return _dio.get('/friday/tasks/$taskId/presentation');
  }

  // ---- Approvals (Explicit confirmation only) ----
  Future<List<Map<String, dynamic>>> listPendingApprovals() async {
    final res = await _dio.get('/friday/approvals?status=PENDING');
    return List<Map<String, dynamic>>.from(res['approvals'] ?? const []);
  }

  Future<Map<String, dynamic>> approveAction(String approvalId, {String? resolution}) {
    return _dio.post('/friday/approvals/$approvalId/approve', data: {
      if (resolution != null) 'resolution': resolution,
    });
  }

  Future<Map<String, dynamic>> rejectAction(String approvalId, {String? reason}) {
    return _dio.post('/friday/approvals/$approvalId/reject', data: {
      if (reason != null) 'reason': reason,
    });
  }

  // ---- Financial Intelligence ----
  Future<Map<String, dynamic>> getFinanceOverview() {
    return _dio.get('/friday/finance/overview');
  }

  Future<Map<String, dynamic>> recordFinanceTransaction({
    required String txType,
    required String category,
    required String amount,
    String? description,
  }) {
    return _dio.post('/friday/finance/transactions', data: {
      'txType': txType,
      'category': category,
      'amount': amount,
      if (description != null) 'description': description,
      'sourceClassification': 'USER_ENTERED',
    });
  }

  // ---- Trading Copilot ----
  Future<Map<String, dynamic>> getTradingOverview() {
    return _dio.get('/friday/trading/overview');
  }

  Future<Map<String, dynamic>> confirmTradingCapital({
    required String totalEquity,
    required String availableCash,
    required String allocatedCapital,
    required bool confirmedByUser,
  }) {
    return _dio.post('/friday/trading/capital/confirm', data: {
      'totalEquity': totalEquity,
      'availableCash': availableCash,
      'allocatedCapital': allocatedCapital,
      'confirmedByUser': confirmedByUser,
    });
  }
}
