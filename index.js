const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const multer = require('multer');
const path = require('path');

const app = express();

// Configurar middlewares
app.use(cors());
app.use(express.json());
// Permite que la web acceda a los PDFs guardados
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Configurar la conexión a la base de datos MySQL
const db = mysql.createConnection({
    host: 'mysql-35aae18a-proyectomvp.b.aivencloud.com',
    user: 'avnadmin',
    password: 'AVNS_zEBoe7E10tmZY0vC1V-',
    port: 19611,
    database: 'sistemaasistencia', 
    ssl: {
        rejectUnauthorized: false
    }
});

// Conectar a la base de datos
db.connect((err) => {
    if (err) {
        console.error('Error conectando a la base de datos:', err);
        return;
    }
    console.log('Conectado con exito a la base de datos');
});

// Función global para registrar acciones en la auditoría
function registrarAuditoria(idUsuarioActor, tablaAfectada, idAfectado, accion, descripcion) {
    const query = `
        INSERT INTO historialauditoria 
        (idUsuarioActor, tablaAfectada, idAfectado, accion, descripcion) 
        VALUES (?, ?, ?, ?, ?)
    `;
    db.query(query, [idUsuarioActor, tablaAfectada, idAfectado, accion, descripcion], (err) => {
        if (err) console.error('Error al guardar en auditoría:', err);
    });
}

// Ruta de prueba
app.get('/api/estado', (req, res) => {
    res.json({ mensaje: 'El servidor backend de Asistencia está funcionando correctamente.' });
});

// ==========================================
// ENDPOINT LOGIN
// ==========================================
app.post('/api/login', (req, res) => {
    const { correo, contrasena } = req.body;
    const query = 'SELECT * FROM usuario WHERE correo = ? AND contrasena = ?';

    db.query(query, [correo, contrasena], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Error interno del servidor' });
        }

        if (results.length > 0) {
            const usuario = results[0];
            
            // 🚀 AUDITORÍA: Registro de inicio de sesión
            registrarAuditoria(usuario.idUsuario, 'Usuario', usuario.idUsuario, 'LOGIN', 'Inicio de sesión exitoso en el sistema');

            res.json({ 
                success: true, 
                mensaje: 'Inicio de sesión exitoso',
                usuario: usuario 
            });
        } else {
            res.status(401).json({ success: false, mensaje: 'Correo o contraseña incorrectos' });
        }
    });
});

// ==========================================
// ENDPOINT ASISTENCIA (QR)
// ==========================================
app.post('/api/marcar-asistencia', (req, res) => {
    const { codigoQR } = req.body;
    const queryBuscar = 'SELECT idUsuario, nombre FROM usuario WHERE codigoQR = ?';
    
    db.query(queryBuscar, [codigoQR], (err, usuarios) => {
        if (err) return res.status(500).json({ error: 'Error en la base de datos' });
        if (usuarios.length === 0) return res.status(404).json({ success: false, mensaje: 'Código QR no reconocido' });

        const usuario = usuarios[0];
        const fechaActual = new Date().toISOString().split('T')[0];
        const horaActual = new Date().toTimeString().split(' ')[0];
        const queryComprobar = 'SELECT idRegistro, horaEntrada, horaSalida, estadoAsistencia FROM registroasistencia WHERE idUsuario = ? AND fecha = ?';
        
        db.query(queryComprobar, [usuario.idUsuario, fechaActual], (err, registros) => {
            if (err) return res.status(500).json({ error: 'Error al comprobar registro' });

            if (registros.length === 0) {
                // ESCENARIO A: ENTRADA
                let estadoEntrada = horaActual > '09:30:00' ? 'ATRASADO' : 'ASISTENCIA COMPLETA';
                const queryEntrada = 'INSERT INTO registroasistencia (idUsuario, fecha, horaEntrada, estadoAsistencia) VALUES (?, ?, ?, ?)';
                
                // NOTA: Agregamos "result" para obtener el ID de la nueva fila
                db.query(queryEntrada, [usuario.idUsuario, fechaActual, horaActual, estadoEntrada], (err, result) => {
                    if (err) return res.status(500).json({ error: 'Error al guardar entrada' });
                    
                    // 🚀 AUDITORÍA: Registro de entrada
                    registrarAuditoria(usuario.idUsuario, 'RegistroAsistencia', result.insertId, 'INSERT', `Marcó entrada con estado: ${estadoEntrada}`);

                    res.json({ success: true, mensaje: `Entrada registrada (${estadoEntrada}) para ${usuario.nombre}`, hora: horaActual });
                });
                
            } else {
                const registroHoy = registros[0];
                if (registroHoy.horaSalida === null) {
                    // ESCENARIO B: SALIDA
                    let estadoSalida = registroHoy.estadoAsistencia; 
                    if (horaActual < '17:30:00') estadoSalida = 'SALIDA ANTICIPADA';
                    
                    const querySalida = `
                        UPDATE registroasistencia 
                        SET horaSalida = ?, horasTrabajadas = ROUND(TIME_TO_SEC(TIMEDIFF(?, horaEntrada))/3600, 2), estadoAsistencia = ?
                        WHERE idRegistro = ?
                    `;
                    
                    db.query(querySalida, [horaActual, horaActual, estadoSalida, registroHoy.idRegistro], (err) => {
                        if (err) return res.status(500).json({ error: 'Error al guardar salida' });
                        
                        // 🚀 AUDITORÍA: Registro de salida
                        registrarAuditoria(usuario.idUsuario, 'RegistroAsistencia', registroHoy.idRegistro, 'UPDATE', `Marcó salida con estado: ${estadoSalida}`);

                        res.json({ success: true, mensaje: `Salida registrada (${estadoSalida}) para ${usuario.nombre}`, hora: horaActual });
                    });
                } else {
                    res.json({ success: false, mensaje: `${usuario.nombre}, tu turno de hoy ya está completo.` });
                }
            }
        });
    });
});

// ==========================================
// MÓDULO CRUD DE USUARIOS
// ==========================================
app.get('/api/usuarios', (req, res) => {
    const queryListar = 'SELECT u.idUsuario, u.rut, u.nombre, u.correo, r.nombreRol FROM usuario u INNER JOIN rol r ON u.idRol = r.idRol';
    db.query(queryListar, (err, resultados) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error en la base de datos' });
        res.json({ success: true, usuarios: resultados });
    });
});

app.post('/api/usuarios', (req, res) => {
    const { rut, nombre, correo, contrasena } = req.body;
    const idRol = 2; 
    const datosEmpleador = 'Empresa de Prueba SpA';
    const codigoGenerado = 'EMP-' + rut.split('-')[0];
    const queryInsertar = 'INSERT INTO usuario (idRol, rut, nombre, correo, contrasena, datosEmpleador, codigoQR) VALUES (?, ?, ?, ?, ?, ?, ?)';
    
    db.query(queryInsertar, [idRol, rut, nombre, correo, contrasena, datosEmpleador, codigoGenerado], (err, result) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al guardar en la base de datos' });
        
        // 🚀 AUDITORÍA: Administrador crea usuario (Usamos ID 1 por defecto para el admin general)
        registrarAuditoria(1, 'Usuario', result.insertId, 'INSERT', `Creó la cuenta del trabajador ${nombre}`);

        res.json({ success: true, mensaje: 'Usuario creado exitosamente' });
    });
});

app.put('/api/usuarios/:id', (req, res) => {
    const idUsuario = req.params.id;
    const { rut, nombre, correo } = req.body;
    const queryEditar = 'UPDATE usuario SET rut = ?, nombre = ?, correo = ? WHERE idUsuario = ?';
    
    db.query(queryEditar, [rut, nombre, correo, idUsuario], (err, result) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al actualizar en la base de datos' });
        
        // 🚀 AUDITORÍA: Administrador edita usuario
        registrarAuditoria(1, 'Usuario', idUsuario, 'UPDATE', `Modificó los datos del trabajador ${nombre}`);

        res.json({ success: true, mensaje: 'Usuario modificado exitosamente' });
    });
});

app.delete('/api/usuarios/:id', (req, res) => {
    const idUsuario = req.params.id;
    const queryEliminar = 'DELETE FROM usuario WHERE idUsuario = ?';
    
    db.query(queryEliminar, [idUsuario], (err, result) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al eliminar en la base de datos' });
        
        // 🚀 AUDITORÍA: Administrador elimina usuario
        registrarAuditoria(1, 'Usuario', idUsuario, 'DELETE', `Eliminó a un trabajador del sistema`);

        res.json({ success: true, mensaje: 'Usuario eliminado exitosamente' });
    });
});

// ==========================================
// MÓDULO DE REPORTES (RE-01, RE-02, RE-03)
// ==========================================
app.get('/api/reportes/atrasos', (req, res) => {
    const query = "SELECT u.rut, u.nombre, r.fecha, r.horaEntrada FROM registroasistencia r INNER JOIN usuario u ON r.idUsuario = u.idUsuario WHERE r.estadoAsistencia = 'ATRASADO' ORDER BY r.fecha DESC, r.horaEntrada DESC";
    db.query(query, (err, resultados) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al obtener atrasos' });
        res.json({ success: true, datos: resultados });
    });
});

app.get('/api/reportes/salidas-anticipadas', (req, res) => {
    const query = "SELECT u.rut, u.nombre, r.fecha, r.horaSalida FROM registroasistencia r INNER JOIN usuario u ON r.idUsuario = u.idUsuario WHERE r.estadoAsistencia = 'SALIDA ANTICIPADA' ORDER BY r.fecha DESC, r.horaSalida DESC";
    db.query(query, (err, resultados) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al obtener salidas anticipadas' });
        res.json({ success: true, datos: resultados });
    });
});

app.get('/api/reportes/inasistencias/:fecha', (req, res) => {
    const fechaConsulta = req.params.fecha;
    const query = "SELECT rut, nombre FROM usuario WHERE idRol = 2 AND idUsuario NOT IN (SELECT idUsuario FROM registroasistencia WHERE fecha = ?)";
    db.query(query, [fechaConsulta], (err, resultados) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al obtener inasistencias' });
        res.json({ success: true, datos: resultados });
    });
});

app.get('/api/mi-historial/:qr', (req, res) => {
    const qrWorker = req.params.qr;
    const query = "SELECT r.fecha, r.horaEntrada, r.horaSalida, r.estadoAsistencia FROM registroasistencia r INNER JOIN usuario u ON r.idUsuario = u.idUsuario WHERE u.codigoQR = ? ORDER BY r.fecha DESC LIMIT 10";
    db.query(query, [qrWorker], (err, resultados) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error en la base de datos' });
        res.json({ success: true, historial: resultados });
    });
});

// ==========================================
// MÓDULO JUSTIFICACIONES
// ==========================================
const almacenamiento = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: almacenamiento });

app.post('/api/justificaciones', upload.single('archivo'), (req, res) => {
    // Capturamos las nuevas fechas
    const { idUsuario, motivo, fechaInicio, fechaFin, profesionalEmisor } = req.body;
    const rutaPDF = req.file.filename;

    // Agregamos fechaInicio y fechaFin a la consulta
    const query = `INSERT INTO justificacion (idUsuario, motivo, fechaInicio, fechaFin, profesionalEmisor, rutaPDF, estadoSolicitud) 
                   VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')`;
    
    db.query(query, [idUsuario, motivo, fechaInicio, fechaFin, profesionalEmisor, rutaPDF], (err, result) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al guardar la licencia' });
        res.json({ success: true, mensaje: 'Licencia enviada correctamente' });
    });
});

// ==========================================
// NUEVOS ENDPOINTS: ADMINISTRACIÓN Y AUDITORÍA
// ==========================================

// 1. Obtener licencias pendientes para el jefe
app.get('/api/admin/justificaciones', (req, res) => {
    const query = `
        SELECT j.idJustificacion, j.motivo, j.profesionalEmisor, j.rutaPDF, j.estadoSolicitud, u.nombre, u.rut 
        FROM justificacion j
        INNER JOIN usuario u ON j.idUsuario = u.idUsuario
        WHERE j.estadoSolicitud = 'PENDIENTE'
    `;
    db.query(query, (err, resultados) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error en BD' });
        res.json({ success: true, datos: resultados });
    });
});

// 2. Jefe aprueba o rechaza una licencia
app.put('/api/admin/justificaciones/:id', (req, res) => {
    const idJustificacion = req.params.id;
    const { estado, idAdministrador } = req.body; 

    const queryUpdate = 'UPDATE justificacion SET estadoSolicitud = ? WHERE idJustificacion = ?';
    
    db.query(queryUpdate, [estado, idJustificacion], (err, result) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error al actualizar' });
        
        registrarAuditoria(idAdministrador, 'justificacion', idJustificacion, 'UPDATE', `Marcó la licencia como ${estado}`);

        // MAGIA: Si el jefe aprueba, rellenamos la asistencia como JUSTIFICADO
        if (estado === 'APROBADO') {
            db.query('SELECT idUsuario, fechaInicio, fechaFin FROM justificacion WHERE idJustificacion = ?', [idJustificacion], (err, filas) => {
                if (!err && filas.length > 0) {
                    const { idUsuario, fechaInicio, fechaFin } = filas[0];
                    
                    // Creamos un bucle que recorre día por día desde el inicio hasta el fin de la licencia
                    let fechaActual = new Date(fechaInicio);
                    const fechaLimite = new Date(fechaFin);
                    
                    while (fechaActual <= fechaLimite) {
                        // Extraemos la fecha en formato YYYY-MM-DD
                        let fechaStr = fechaActual.toISOString().split('T')[0];
                        
                        // Insertamos la justificación en el registro de asistencia de ese día
                        db.query('INSERT INTO registroasistencia (idUsuario, fecha, estado) VALUES (?, ?, "JUSTIFICADO")', [idUsuario, fechaStr]);
                        
                        // Avanzamos al siguiente día
                        fechaActual.setDate(fechaActual.getDate() + 1);
                    }
                }
            });
        }

        res.json({ success: true, mensaje: `Licencia ${estado} con éxito` });
    });
});

// 3. Obtener el historial de auditoría
app.get('/api/admin/auditoria', (req, res) => {
    // Cambiamos historialAuditoria a minúsculas, por si acaso
    const query = `
        SELECT h.idHistorial, h.fechaHora, h.tablaAfectada, h.accion, h.descripcion, u.nombre as actor
        FROM historialauditoria h
        LEFT JOIN usuario u ON h.idUsuarioActor = u.idUsuario
        ORDER BY h.idHistorial DESC
        LIMIT 30
    `;
    db.query(query, (err, resultados) => {
        if (err) {
            // 🔥 Agregamos esto para ver el error exacto en Render si vuelve a fallar
            console.error('🔥 ERROR SQL AUDITORIA:', err); 
            return res.status(500).json({ success: false, mensaje: 'Error al obtener auditoría' });
        }
        res.json({ success: true, datos: resultados });
    });
});

// Obtener el historial completo de licencias resueltas (APROBADAS / RECHAZADAS)
app.get('/api/admin/justificaciones-historial', (req, res) => {
    const query = `
        SELECT j.idJustificacion, j.motivo, j.profesionalEmisor, j.rutaPDF, j.estadoSolicitud, u.nombre, u.rut 
        FROM justificacion j
        INNER JOIN usuario u ON j.idUsuario = u.idUsuario
        WHERE j.estadoSolicitud != 'PENDIENTE'
        ORDER BY j.idJustificacion DESC
    `;
    db.query(query, (err, resultados) => {
        if (err) return res.status(500).json({ success: false, mensaje: 'Error en BD' });
        res.json({ success: true, datos: resultados });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});