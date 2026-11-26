import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

class CachedConversationItem {
  final String id;
  final String role;
  final String text;
  final String timestamp;

  const CachedConversationItem({
    required this.id,
    required this.role,
    required this.text,
    required this.timestamp,
  });
}

class LocalActivityRecord {
  final String id;
  final String action;
  final String detail;
  final String mode;
  final String createdAt;

  const LocalActivityRecord({
    required this.id,
    required this.action,
    required this.detail,
    required this.mode,
    required this.createdAt,
  });
}

abstract class LocalDatabase {
  Future<void> initialize();
  Future<void> saveMessage(CachedConversationItem item);
  Future<List<CachedConversationItem>> getMessages({int limit = 50});
  Future<void> logActivity(LocalActivityRecord record);
  Future<List<LocalActivityRecord>> getActivities({int limit = 50});
  Future<void> close();
}

class SqliteLocalDatabase implements LocalDatabase {
  Database? _db;

  @override
  Future<void> initialize() async {
    if (_db != null) return;
    final dbPath = await getDatabasesPath();
    final fullPath = p.join(dbPath, 'friday_companion.db');
    _db = await openDatabase(
      fullPath,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE cached_messages (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            timestamp TEXT NOT NULL
          )
        ''');
        await db.execute('''
          CREATE TABLE activity_history (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            detail TEXT NOT NULL,
            mode TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        ''');
      },
    );
  }

  @override
  Future<void> saveMessage(CachedConversationItem item) async {
    await initialize();
    await _db?.insert(
      'cached_messages',
      {
        'id': item.id,
        'role': item.role,
        'text': item.text,
        'timestamp': item.timestamp,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  @override
  Future<List<CachedConversationItem>> getMessages({int limit = 50}) async {
    await initialize();
    final rows = await _db?.query(
          'cached_messages',
          orderBy: 'timestamp DESC',
          limit: limit,
        ) ??
        [];
    return rows
        .map((r) => CachedConversationItem(
              id: r['id'].toString(),
              role: r['role'].toString(),
              text: r['text'].toString(),
              timestamp: r['timestamp'].toString(),
            ))
        .toList()
        .reversed
        .toList();
  }

  @override
  Future<void> logActivity(LocalActivityRecord record) async {
    await initialize();
    await _db?.insert(
      'activity_history',
      {
        'id': record.id,
        'action': record.action,
        'detail': record.detail,
        'mode': record.mode,
        'created_at': record.createdAt,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  @override
  Future<List<LocalActivityRecord>> getActivities({int limit = 50}) async {
    await initialize();
    final rows = await _db?.query(
          'activity_history',
          orderBy: 'created_at DESC',
          limit: limit,
        ) ??
        [];
    return rows
        .map((r) => LocalActivityRecord(
              id: r['id'].toString(),
              action: r['action'].toString(),
              detail: r['detail'].toString(),
              mode: r['mode'].toString(),
              createdAt: r['created_at'].toString(),
            ))
        .toList();
  }

  @override
  Future<void> close() async {
    await _db?.close();
    _db = null;
  }
}

class InMemoryLocalDatabase implements LocalDatabase {
  final List<CachedConversationItem> _messages = [];
  final List<LocalActivityRecord> _activities = [];

  @override
  Future<void> initialize() async {}

  @override
  Future<void> saveMessage(CachedConversationItem item) async {
    _messages.add(item);
  }

  @override
  Future<List<CachedConversationItem>> getMessages({int limit = 50}) async {
    return _messages.length <= limit
        ? List.unmodifiable(_messages)
        : _messages.sublist(_messages.length - limit);
  }

  @override
  Future<void> logActivity(LocalActivityRecord record) async {
    _activities.insert(0, record);
  }

  @override
  Future<List<LocalActivityRecord>> getActivities({int limit = 50}) async {
    return _activities.take(limit).toList();
  }

  @override
  Future<void> close() async {}
}
