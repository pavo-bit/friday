class ChatMessage {
  final String role;
  final String text;
  final String timestamp;

  ChatMessage({
    required this.role,
    required this.text,
    required this.timestamp,
  });
}

class WatcherItem {
  final String id;
  final String name;
  final String targetUrl;
  final String status;
  final String health;
  final bool workerRunning;

  WatcherItem({
    required this.id,
    required this.name,
    required this.targetUrl,
    required this.status,
    required this.health,
    required this.workerRunning,
  });

  factory WatcherItem.fromJson(Map<String, dynamic> json) {
    return WatcherItem(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      targetUrl: json['targetUrl']?.toString() ?? '',
      status: json['status']?.toString() ?? 'unknown',
      health: json['health']?.toString() ?? 'unknown',
      workerRunning: json['workerRunning'] == true,
    );
  }
}

class ReminderItem {
  final String id;
  final String title;
  final String? dueAt;
  final String recurrence;
  final String status;
  final bool isAlarm;

  ReminderItem({
    required this.id,
    required this.title,
    this.dueAt,
    required this.recurrence,
    required this.status,
    required this.isAlarm,
  });

  factory ReminderItem.fromJson(Map<String, dynamic> json) {
    return ReminderItem(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? '',
      dueAt: json['dueAt']?.toString(),
      recurrence: json['recurrence']?.toString() ?? 'none',
      status: json['status']?.toString() ?? 'pending',
      isAlarm: json['isAlarm'] == true,
    );
  }
}

class NotificationItem {
  final String id;
  final String severity;
  final String title;
  final String message;
  final bool isRead;
  final String createdAt;

  NotificationItem({
    required this.id,
    required this.severity,
    required this.title,
    required this.message,
    required this.isRead,
    required this.createdAt,
  });

  factory NotificationItem.fromJson(Map<String, dynamic> json) {
    return NotificationItem(
      id: json['id']?.toString() ?? '',
      severity: json['severity']?.toString() ?? 'info',
      title: json['title']?.toString() ?? '',
      message: json['message']?.toString() ?? '',
      isRead: json['isRead'] == true,
      createdAt: json['createdAt']?.toString() ?? '',
    );
  }
}

class SavedLocationItem {
  final String id;
  final String name;
  final double latitude;
  final double longitude;
  final int radiusMeters;

  SavedLocationItem({
    required this.id,
    required this.name,
    required this.latitude,
    required this.longitude,
    required this.radiusMeters,
  });

  factory SavedLocationItem.fromJson(Map<String, dynamic> json) {
    return SavedLocationItem(
      id: json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      latitude: (json['latitude'] as num?)?.toDouble() ?? 0.0,
      longitude: (json['longitude'] as num?)?.toDouble() ?? 0.0,
      radiusMeters: (json['radiusMeters'] as num?)?.toInt() ?? 150,
    );
  }
}
